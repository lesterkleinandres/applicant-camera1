# TIPON STU-540 signature capture

This page is opened by the bound Google Sheets `ApplicantSignature.html` dialog. Opening it directly intentionally disables capture because there is no active applicant session.

## Windows 11 setup

1. Connect the Wacom STU-540 by USB in USB HID mode.
2. Install **STU SigCaptX for Windows** from [Wacom Developer Dashboard](https://developer.wacom.com/developer-dashboard), under Wacom Device Kit → STU SDK for Windows Desktop. Follow the official [getting-started guide](https://github.com/Wacom-Developer/stu-sdk-sigcaptx-samples/blob/master/GETTING-STARTED.md). The STU driver alone is not the SigCaptX service.
3. Install the [Wacom STU driver](https://developer-support.wacom.com/hc/en-us/articles/9354527258007-STU-Driver-Installation). Complete any installer-requested restart or sign-out.
4. In Chrome or Edge, open the TIPON sheet and its existing Capture Signature dialog. Choose **Wacom STU-540**, then **Connect signature pad**. Allow the requested popup and local network/device connection permission for this capture page.
5. Sign on the pad. Choose **Save Signature** once. Keep the sheet dialog open until the save is confirmed. The capture window and dialog then close automatically.

Use Wacom's included PortCheck and demo if connection fails. Close other programs using the pad. Do not disable browser certificate checks; resolve certificate/service installation problems using Wacom support.

## Apps Script installation

Replace only `ApplicantSignature.html` with the copy in `../apps-script/`. Add `SignatureDevice.gs` as an additional script file. Preserve `ApplicantCapture.gs`, `SignatureSync.gs`, and all camera files. This requires the existing functions/configuration:

- `openApplicantSignatureCapture()` providing the `applicantName` template value.
- `APPLICANT_CAPTURE_CONFIG` and `getApplicantCaptureName_(sheet)`.
- `saveApplicantSignatureCapture(dataUrl)`, returning `{success: true}` after its existing Drive save, sheet insertion, and form synchronization.

The bound dialog uses saved source, so these changes do not require redeploying the photo web app. Reopen the signature dialog after saving the source.

## Data and checks

Signatures remain in browser memory until Save. The static GitHub page does not upload signatures to GitHub. It sends an 840 × 480 transparent PNG to its opener, which calls the existing Apps Script save function. The existing 210 × 120 insertion keeps the same aspect ratio. This captures a signature image; it is not a cryptographic digital signature.

Both windows validate exact origins, window references, and a random session token. The URL fragment contains only a session token and parent origin. The backend checks the selected applicant name, image size, and session ID, and uses a lock plus a best-effort six-hour per-user cache to prevent repeat saves. A failed or unconfirmed save requires checking the form before recapturing. A name check cannot distinguish two applicants with identical names.

Actual USB operation and final insertion must be tested on the Windows laptop with the STU-540 attached. Automated message/save-flow tests do not establish hardware compatibility on that laptop.

## Vendor files

`vendor/q.js` and `vendor/wgssStuSdk.js` are unmodified files from [Wacom's official STU SigCaptX sample](https://github.com/Wacom-Developer/stu-sdk-sigcaptx-samples/tree/master/samples/demobuttons). Wacom's MIT license and Q's MIT/Apache notices are retained in `vendor/`.
