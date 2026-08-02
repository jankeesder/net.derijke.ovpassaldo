'use strict';

/**
 * Kleine, herbruikbare client rond de (onofficiële) anonieme OVpay API.
 *
 * De API vereist geen authenticatie: pasnummer + volgnummer volstaan.
 * Endpoint:
 *   GET https://api.ovpay.nl/api/anonymous/v1/TransitAccounts/ovpas
 *       ?cardNumber={cardNumber}&cardSequenceNumber={cardSequenceNumber}
 *
 * Voorbeeldrespons (velden die wij gebruiken):
 *   {
 *     "status": "Active",
 *     "arlStatus": "Active",
 *     "balance": 15000,                         // eurocenten -> € 150,00
 *     "expirationDate": "2031-06-30T23:59:00+02:00",
 *     "debt": null,
 *     ...
 *   }
 */

const BASE_URL = 'https://api.ovpay.nl/api/anonymous/v1/TransitAccounts/ovpas';
const REQUEST_TIMEOUT_MS = 15000;

// Homey Pro (2023+) draait op Node 18+ en heeft globale fetch. Voor oudere
// firmware valt de client terug op de node-fetch dependency uit package.json.
let fetchFn = globalThis.fetch;
if (typeof fetchFn !== 'function') {
  // eslint-disable-next-line global-require
  fetchFn = require('node-fetch');
}

class OVpayApi {

  /**
   * Haalt de ruwe kaartgegevens op bij OVpay.
   * @param {string} cardNumber        Pasnummer (bijv. "A12BCDE")
   * @param {string} cardSequenceNumber Volgnummer (bijv. "A1BC")
   * @returns {Promise<object>} De ruwe JSON-respons.
   * @throws {Error} bij netwerkfouten, timeouts of niet-2xx statuscodes.
   */
  static async getCard(cardNumber, cardSequenceNumber) {
    const url = `${BASE_URL}`
      + `?cardNumber=${encodeURIComponent(cardNumber)}`
      + `&cardSequenceNumber=${encodeURIComponent(cardSequenceNumber)}`;

    // Globale fetch kent geen timeout-optie -> zelf afbreken via AbortController.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetchFn(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(`OVpay API gaf HTTP ${res.status} terug`);
      }
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Formatteert een bedrag in euro's naar Nederlandse notatie:
   *   - heel getal   -> "€35,-"
   *   - met centen   -> "€35,65"
   * @param {number} amount Bedrag in euro's.
   * @returns {string}
   */
  static formatEUR(amount) {
    if (!Number.isFinite(amount)) return '€0,-';
    if (Number.isInteger(amount)) return `€${amount},-`;
    return `€${amount.toFixed(2).replace('.', ',')}`;
  }

  /**
   * Normaliseert de ruwe API-respons naar een voorspelbaar, door de rest van
   * de app gebruikt formaat. Hier zit alle "business logic" over bruikbaarheid.
   *
   * @param {object} raw De ruwe JSON van getCard().
   * @returns {{
   *   balanceEUR: number,
   *   balanceText: string,
   *   expiryDate: (Date|null),
   *   isExpired: boolean,
   *   usable: boolean,
   *   unusableReason: string,
   *   statusLabel: string,
   *   raw: object
   * }}
   */
  static normalize(raw = {}) {
    // --- Saldo: eurocenten -> euro's als getal (2 decimalen) ---
    const balanceCents = Number.isFinite(raw.balance) ? raw.balance : 0;
    const balanceEUR = Math.round(balanceCents) / 100;
    const balanceText = OVpayApi.formatEUR(balanceEUR);

    // --- Vervaldatum ---
    const expiryDate = raw.expirationDate ? new Date(raw.expirationDate) : null;
    const isExpired = expiryDate ? expiryDate.getTime() < Date.now() : false;

    // --- Bruikbaarheid bepalen ---
    // De kaart is bruikbaar als status actief is, de ARL-status (deny list)
    // niet blokkeert, de kaart niet verlopen is en er geen schuld openstaat.
    const statusActive = String(raw.status).toLowerCase() === 'active';
    const arlActive = raw.arlStatus == null
      || String(raw.arlStatus).toLowerCase() === 'active';
    const hasDebt = Number.isFinite(raw.debt) && raw.debt > 0;

    const usable = statusActive && arlActive && !isExpired && !hasDebt;

    // --- Exacte reden meegeven als flow-token ---
    let unusableReason = null;
    if (!statusActive) {
      unusableReason = `Kaartstatus: ${raw.status ?? 'onbekend'}`;
    } else if (!arlActive) {
      unusableReason = `Geblokkeerd (ARL-status: ${raw.arlStatus})`;
    } else if (isExpired) {
      unusableReason = `Verlopen op ${expiryDate.toLocaleDateString('nl-NL')}`;
    } else if (hasDebt) {
      unusableReason = `Openstaande schuld: € ${(raw.debt / 100).toFixed(2)}`;
    }

    const statusLabel = usable ? 'Bruikbaar' : (unusableReason || 'Onbruikbaar');

    return {
      balanceEUR,
      balanceText,
      expiryDate,
      isExpired,
      usable,
      unusableReason: unusableReason || 'Onbekend',
      statusLabel,
      raw,
    };
  }
}

module.exports = OVpayApi;
