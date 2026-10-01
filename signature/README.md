# TIPON STU-540 signature capture — direct WebHID

This page is opened by the bound Google Sheets `ApplicantSignature.html` dialog. Opening it directly intentionally disables capture because there is no active applicant session.

## Windows 11 setup

1. Connect the Wacom STU-540 by USB in USB HID mode.
2. In desktop Chrome or Edge, open the TIPON sheet and its existing Capture Signature dialog. Choose **Wacom STU-540**, then **Connect signature pad**.
3. Select the STU-540 in the browser device chooser and allow the USB connection.
4. Sign on the pad. Choose **Save Signature** once. Keep the sheet dialog open until the save is confirmed. The capture window and dialog then close automatically.

This version uses Windows' built-in HID support through WebHID. It does not load SigCaptX, require a separately installed Wacom STU driver, contact a localhost service, or use the paid Wacom Signature SDK. The device chooser requires a click in a secure, top-level browser page. Firefox and Safari are not supported for this USB capture.

If the pad is absent or busy, close other programs/tabs using it and reconnect its USB cable. If it is configured in serial mode, it must be returned to USB HID mode using Wacom's supported procedure. An organisation's browser/device policy can also block WebHID; contact IT rather than disabling security protections.

## Apps Script installation

Replace only `ApplicantSignature.html` with the copy in `../apps-script/`. Add `SignatureDevice.gs` as an additional script file. Preserve `ApplicantCapture.gs`, `SignatureSync.gs`, and all camera files. This requires the existing functions/configuration:

- `openApplicantSignatureCapture()` providing the `applicantName` template value.
- `APPLICANT_CAPTURE_CONFIG` and `getApplicantCaptureName_(sheet)`.
- `saveApplicantSignatureCapture(dataUrl)`, returning `{success: true}` after its existing Drive save, sheet insertion, and form synchronization.

The bound dialog uses saved source, so these changes do not require redeploying the photo web app. The WebHID conversion only changes the GitHub capture page: the Apps Script files already installed for the popup bridge can remain as they are. Close old capture windows and reopen the signature dialog after publishing.

## Data and checks

Signatures remain in browser memory until Save. The static GitHub page does not upload signatures to GitHub. It sends an 840 × 480 transparent PNG to its opener, which calls the existing Apps Script save function. The existing 210 × 120 insertion keeps the same aspect ratio. This captures a signature image; it is not a cryptographic digital signature.

Both windows validate exact origins, window references, and a random session token. The URL fragment contains only a session token and parent origin. The backend checks the selected applicant name, image size, and session ID, and uses a lock plus a best-effort six-hour per-user cache to prevent repeat saves. A failed or unconfirmed save requires checking the form before recapturing. A name check cannot distinguish two applicants with identical names.

Actual USB operation and final insertion must be tested on the Windows laptop with the STU-540 attached. Automated message/save-flow tests do not establish hardware compatibility on that laptop.

## Automated checks

From the repository root, run `node test.cjs` and `node webhid-test.cjs`. These use simulated browser/Apps Script/USB objects and perform no production writes. They cover message validation, one-time submission, save confirmation, applicant checks, USB framing, image transfers, cancellation and device cleanup.

## Vendor files

`stu540-webhid.js` is adapted from [Pablo García's MIT-licensed STU-540 WebHID project](https://github.com/pabloko/Wacom-STU-WebHID), source blob `a8cab342da91312105ee685271a9d69d8a9b5659`. Its copyright and license are retained in `vendor/WEBHID-LICENSE.txt`. This is a community integration, not an official Wacom SDK. It captures a PNG image and does not implement Wacom's encrypted biometric signature formats.

The adapter validates device capabilities and input lengths, decodes coordinates without modifying input buffers, sends display chunks sequentially, reports connection failures, and releases the device when cancelled or disconnected. A 1-bit display image keeps the USB transfer small; the captured PNG remains transparent with black ink. Hardware testing is still required for the specific laptop, firmware and USB connection.

The previous `signature.js`, `vendor/q.js` and `vendor/wgssStuSdk.js` files and their licenses are retained for historical reference but are not loaded by the current page. Separate script filenames prevent an older cached HTML page from loading an incompatible new adapter.
