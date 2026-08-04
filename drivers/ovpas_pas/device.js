'use strict';

const Homey = require('homey');
const OVpayApi = require('../../lib/OVpayApi');

// Standaard poll-interval (minuten) als er (nog) geen instelling is.
const DEFAULT_POLL_MINUTES = 15;

class OVpayDevice extends Homey.Device {

  async onInit() {
    this.log(`OV-pas "${this.getName()}" initialiseren`);

    // Zorg dat capabilities bestaan (ook na een app-upgrade).
    for (const cap of ['ovpas_balance_display', 'ovpas_status', 'refresh_now', 'measure_ovpas_balance']) {
      if (!this.hasCapability(cap)) await this.addCapability(cap).catch(this.error);
    }

    // Knop op het device: handmatig verversen.
    this.registerCapabilityListener('refresh_now', async () => {
      this.log('Handmatig verversen via knop');
      await this.refresh();
    });

    // Onthoud de laatst bekende bruikbaarheid om alleen op een *overgang*
    // naar "onbruikbaar" te triggeren (niet elke poll opnieuw).
    this._lastUsable = null;

    // Eerste refresh direct bij opstarten, daarna periodiek pollen.
    await this.refresh();
    this._startPolling();
  }

  /** Poll-interval in ms, afgeleid van de device-instelling (met fallback). */
  _getPollMs(minutesOverride) {
    const minutes = Number(minutesOverride ?? this.getSetting('pollInterval'));
    const safe = Number.isFinite(minutes) && minutes >= 1 ? minutes : DEFAULT_POLL_MINUTES;
    return safe * 60 * 1000;
  }

  /** (Her)start de poll-timer met het actuele of meegegeven interval. */
  _startPolling(minutesOverride) {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    // this.homey.setInterval wordt door Homey opgeruimd, maar we clearen 'm
    // ook expliciet bij herstart en in onDeleted/onUninit.
    this.pollTimer = this.homey.setInterval(
      () => this.refresh(),
      this._getPollMs(minutesOverride),
    );
    this.log(`Poll-interval ingesteld op ${this._getPollMs(minutesOverride) / 60000} min`);
  }

  /**
   * Kernroutine: haalt de kaartstatus op, werkt de capabilities bij en
   * vuurt indien nodig flows. Faalt nooit hard — bij een API-/netwerkfout
   * blijven de laatst bekende waarden staan en zetten we een warning.
   */
  async refresh() {
    const { cardNumber, cardSequenceNumber } = this.getSettings();

    if (!cardNumber || !cardSequenceNumber) {
      await this.setUnavailable(this.homey.__('device.missing_card'))
        .catch(this.error);
      return;
    }

    let card;
    try {
      const raw = await OVpayApi.getCard(cardNumber, cardSequenceNumber);
      card = OVpayApi.normalize(raw);
    } catch (err) {
      // --- Robuuste error-handling: app mag niet crashen als de API offline is ---
      this.error('OVpay API onbereikbaar:', err.message);
      await this.setWarning(this.homey.__('device.api_unreachable'))
        .catch(() => {});
      return; // laatst bekende capability-waarden blijven behouden
    }

    // Gelukt: device weer beschikbaar en eventuele warning weghalen.
    await this.setAvailable().catch(() => {});
    await this.unsetWarning().catch(() => {});

    const statusLabel = this._statusLabel(card);
    const balanceChanged = await this._updateBalance(card);
    const status = await this._updateStatus(card, statusLabel);
    const changed = balanceChanged || status.changed;

    // Alle settings in ÉÉN keer schrijven (voorkomt botsende setSettings-calls).
    // - lastChecked: elke geslaagde poll (bewijs dat het draait)
    // - lastChanged: alleen als saldo of status daadwerkelijk wijzigde
    // (programmatische setSettings triggert geen onSettings -> geen loop)
    const now = this._formatNow();
    const patch = { lastChecked: now };
    if (changed) patch.lastChanged = now;
    if (status.expiryIso && this.getSetting('expiryDate') !== status.expiryIso) {
      patch.expiryDate = status.expiryIso;
    }
    await this.setSettings(patch).catch(this.error);

    this.log(`Ververst — saldo ${card.balanceText}, status "${statusLabel}", gewijzigd=${changed}`);
  }

  /**
   * Bouwt de vertaalde statustekst op uit de taal-neutrale reden-structuur.
   * @param {object} card Resultaat van OVpayApi.normalize().
   * @returns {string}
   */
  _statusLabel(card) {
    if (card.usable) return this.homey.__('status.usable');
    const r = card.reason || {};
    switch (r.key) {
      case 'status':
        return this.homey.__('status.status', { status: r.status });
      case 'blocked':
        return this.homey.__('status.blocked', { arl: r.arl });
      case 'expired': {
        const d = r.date;
        const date = d ? `${d.getDate()}-${d.getMonth() + 1}-${d.getFullYear()}` : '?';
        return this.homey.__('status.expired', { date });
      }
      case 'debt':
        return this.homey.__('status.debt', { amount: Number(r.amount).toFixed(2) });
      default:
        return this.homey.__('status.unusable');
    }
  }

  /** Huidige tijd in lokale (Homey-)tijdzone, NL-notatie: dd-mm-jjjj uu:mm:ss. */
  _formatNow() {
    try {
      return new Intl.DateTimeFormat('nl-NL', {
        timeZone: this.homey.clock.getTimezone(),
        day: '2-digit', month: '2-digit', year: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      }).format(new Date());
    } catch (err) {
      return new Date().toISOString();
    }
  }

  /**
   * Werkt het saldo bij. De capability-waarden worden ALTIJD gezet (idempotent,
   * zodat ook een nieuw/leeg tekstveld gevuld raakt); de flows vuren alléén
   * wanneer de waarde daadwerkelijk is veranderd (voorkomt spam elke poll).
   */
  async _updateBalance(card) {
    const previous = this.getCapabilityValue('measure_ovpas_balance');
    const changed = previous !== card.balanceEUR;

    // Altijd zetten — ook als de waarde gelijk bleef.
    await this.setCapabilityValue('measure_ovpas_balance', card.balanceEUR)
      .catch(this.error);
    // Leesbare weergave: "€35,-" bij een heel bedrag, anders "€35,65".
    await this.setCapabilityValue('ovpas_balance_display', card.balanceText)
      .catch(this.error);

    if (!changed) return false; // niets veranderd -> geen flows vuren

    // "Het saldo is gewijzigd" — nieuwe waarde als token.
    this.driver.balanceChangedTrigger
      .trigger(this, { balance: card.balanceEUR })
      .catch(this.error);

    // "Het saldo komt onder een bepaalde waarde" — de runListener in de
    // driver filtert op de door de gebruiker ingestelde grens (state.balance).
    this.driver.balanceBelowTrigger
      .trigger(this, { balance: card.balanceEUR }, { balance: card.balanceEUR })
      .catch(this.error);

    return true;
  }

  /**
   * Werkt de status-capability bij en vuurt "kaart niet meer bruikbaar"
   * bij een overgang van bruikbaar -> onbruikbaar.
   * @returns {{changed: boolean, expiryIso: (string|null)}}
   */
  async _updateStatus(card, statusLabel) {
    const changed = this.getCapabilityValue('ovpas_status') !== statusLabel;
    if (changed) {
      await this.setCapabilityValue('ovpas_status', statusLabel)
        .catch(this.error);
    }

    // Trigger alleen bij de overgang naar onbruikbaar (of bij eerste detectie
    // na (her)start). Zo krijg je geen herhaalde meldingen elke poll.
    const becameUnusable = !card.usable && this._lastUsable !== false;
    if (becameUnusable) {
      this.driver.cardUnusableTrigger
        .trigger(this, { reason: statusLabel })
        .catch(this.error);
    }
    this._lastUsable = card.usable;

    // Vervaldatum teruggeven; refresh() schrijft 'm mee in de gebundelde patch.
    return {
      changed,
      expiryIso: card.expiryDate ? card.expiryDate.toISOString() : null,
    };
  }

  /** Gebruiker heeft instellingen aangepast. */
  async onSettings({ newSettings, changedKeys }) {
    // Gewijzigd interval: poll-timer meteen herstarten met de nieuwe waarde
    // én direct één keer verversen, zodat je meteen ziet dat het werkt.
    if (changedKeys.includes('pollInterval')) {
      this._startPolling(newSettings.pollInterval);
      this.homey.setTimeout(() => this.refresh().catch(this.error), 500);
    }

    // Nieuw kaartnummer/volgnummer: geschiedenis resetten en herladen.
    // We wachten kort zodat de nieuwe settings al persistent zijn.
    if (changedKeys.includes('cardNumber') || changedKeys.includes('cardSequenceNumber')) {
      this._lastUsable = null;
      this.homey.setTimeout(() => this.refresh().catch(this.error), 1500);
    }
  }

  async onDeleted() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
    this.log(`OV-pas "${this.getName()}" verwijderd`);
  }

  async onUninit() {
    if (this.pollTimer) this.homey.clearInterval(this.pollTimer);
  }

}

module.exports = OVpayDevice;
