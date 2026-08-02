# OV-Pas Saldo (Homey app)

App-id: `net.derijke.ovpassaldo`. Onofficiële app — niet gelieerd aan of
goedgekeurd door Translink of OVpay.

Homey-app (SDK v3) die het **saldo** en de **status** van een OV-pas ophaalt
via de onofficiële, anonieme OVpay API. Elke OV-pas wordt als los **device**
toegevoegd.

## Werking

- Endpoint (geen authenticatie nodig, alleen pasnummer + volgnummer):
  ```
  GET https://api.ovpay.nl/api/anonymous/v1/TransitAccounts/ovpas?cardNumber={cardNumber}&cardSequenceNumber={cardSequenceNumber}
  ```
- `balance` komt in **eurocenten** terug (`15000` → € 150,00) en wordt naar EUR
  omgerekend in `lib/OVpayApi.js` → `normalize()`.
- Bruikbaarheid wordt afgeleid uit `status`, `arlStatus`, `expirationDate` en `debt`.
- Polling: bij `onInit` en daarna elke **15 minuten**.

## Bestanden

| Bestand | Rol |
|---|---|
| `app.json` | Manifest: driver `ovpay_pas` (class `other`), custom capabilities, flow triggers |
| `app.js` | App-root (minimaal) |
| `lib/OVpayApi.js` | API-client + `normalize()` (alle business logic) |
| `drivers/ovpay_pas/driver.js` | Registreert flow triggers; valideert kaart tijdens pairing |
| `drivers/ovpay_pas/device.js` | Per-kaart logica: pollen, capabilities updaten, flows triggeren |
| `drivers/ovpay_pas/pair/start.html` | Koppelscherm (naam, kaartnummer, volgnummer) |

## Flow triggers

1. **Het saldo is gewijzigd** — token `balance` (EUR).
2. **Het saldo komt onder een bepaalde waarde** — argument `limit` (EUR), token `balance`.
3. **De kaart is niet meer bruikbaar** — token `reason` (exacte status/reden).

## Installeren & draaien

```bash
cd net.derijke.ovpassaldo
npm install
homey app run        # live op je Homey (development)
homey app validate    # controleer het manifest
```

## Nog toe te voegen vóór publicatie

Homey vereist voor de App Store PNG-afbeeldingen (SVG-icons zitten er al in):

- `assets/images/small.png` (250×175) en `large.png` (500×350)
- `drivers/ovpay_pas/assets/images/small.png` (75×75) en `large.png` (500×500)

## Let op

De OVpay API is **onofficieel en ongedocumenteerd**. Veldnamen, pad of toegang
kunnen zonder aankondiging wijzigen; de app is daarom defensief opgezet (bij een
API-/netwerkfout blijven laatst bekende waarden staan en crasht de app niet).
