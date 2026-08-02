'use strict';

const Homey = require('homey');

/**
 * App-root. Bewust minimaal: alle logica leeft in de driver/device en in
 * lib/OVpayApi.js. Zo blijft de app modulair en makkelijk te testen.
 */
class OVpayApp extends Homey.App {

  async onInit() {
    this.log('OVpay OV-pas app gestart');
  }

}

module.exports = OVpayApp;
