'use strict';

const Homey = require('homey');
const OVpayApi = require('../../lib/OVpayApi');

class OVpayDriver extends Homey.Driver {

  async onInit() {
    // --- Flow triggers (device-scoped) één keer registreren ---
    // Devices vuren deze via this.driver.<trigger>.trigger(device, tokens, state).

    this.balanceChangedTrigger = this.homey.flow
      .getDeviceTriggerCard('ovpas_balance_changed');

    this.balanceBelowTrigger = this.homey.flow
      .getDeviceTriggerCard('ovpas_balance_below');
    // De runListener bepaalt of de trigger daadwerkelijk vuurt: alleen wanneer
    // het (net gewijzigde) saldo onder de door de gebruiker ingestelde grens ligt.
    this.balanceBelowTrigger.registerRunListener(
      async (args, state) => state.balance < args.limit,
    );

    this.cardUnusableTrigger = this.homey.flow
      .getDeviceTriggerCard('ovpas_card_unusable');

    // --- Flow condition: "Saldo is (niet) lager dan X" ---
    // Vergelijkt de huidige capability-waarde met de ingestelde grens.
    this.homey.flow
      .getConditionCard('ovpas_balance_is_below')
      .registerRunListener(async (args) => {
        const balance = args.device.getCapabilityValue('measure_ovpas_balance');
        return typeof balance === 'number' && balance < args.limit;
      });

    // --- Flow action: "Ververs saldo en status nu" ---
    this.homey.flow
      .getActionCard('ovpas_refresh')
      .registerRunListener(async (args) => {
        await args.device.refresh();
        return true;
      });

    this.log('OVpay driver geïnitialiseerd');
  }

  /**
   * Custom pairing: het formulier in pair/start.html stuurt de ingevulde
   * kaartgegevens hierheen om ze live te valideren tegen de OVpay API,
   * vóórdat het device wordt aangemaakt.
   */
  onPair(session) {
    session.setHandler('validate_card', async ({ cardNumber, cardSequenceNumber }) => {
      if (!cardNumber || !cardSequenceNumber) {
        throw new Error('Vul zowel het kaartnummer als het volgnummer in.');
      }

      // Gooit een fout wanneer de API onbereikbaar is of de kaart niet bestaat;
      // die fout wordt in de pairing-UI aan de gebruiker getoond.
      const raw = await OVpayApi.getCard(
        cardNumber.trim(),
        cardSequenceNumber.trim(),
      );
      return OVpayApi.normalize(raw);
    });
  }

}

module.exports = OVpayDriver;
