# txext-probe

A throwaway Polkadot product that shows how a host builds `create_transaction` for each `txExtVersion`. It exists to settle why dim2's game transactions fail on the Android host with `Transaction extension version 5 is not supported by runtime`.

For every case it asks the host to build the same `System.remark` for the product account and records:

1. the exact `create_transaction` request;
2. the host's answer or error;
3. the envelope the host built (v4 / v5 general, extension version, `VerifyMultiSignature` variant);
4. a `TaggedTransactionQueue.validate_transaction` dry run.

Nothing is ever broadcast. The probe account is unfunded, so a `Payment` failure in the dry run is expected. It still proves the chain decoded the envelope.

| Case | Request |
|---|---|
| `stock` | the SDK's own product signer decides |
| `v0` | `txExtVersion: 0`, all extensions |
| `v0-noverify` | `txExtVersion: 0`, `VerifyMultiSignature` dropped |
| `v5` | `txExtVersion: 5`, all extensions (what dim2 sends) |
| `v5-noverify` | `txExtVersion: 5`, `VerifyMultiSignature` dropped |
| `v1` | `txExtVersion: 1`, control |

## Reading the logs

- On screen: the Log panel, with Copy.
- Android: `adb logcat | grep txprobe`. The host forwards `console.*` as `ProductWebChromeClientKt: Browser: [txprobe] …`.
- Devtools / CDP: `window.__txprobe.export()` returns the whole run as JSON.

Downloads do not work inside the host, so there is no file export.

## Run and deploy

```bash
npm install
npm run dev            # outside a host: reads People over WS, host cases are skipped
MNEMONIC="…" DOMAIN=txextprobe.paseo npm run deploy:paseo
```

`DOMAIN` is also the product account's `dotNsIdentifier`, baked in at build time via `VITE_PRODUCT_DOTNS`. It must be the name the product is served from.
