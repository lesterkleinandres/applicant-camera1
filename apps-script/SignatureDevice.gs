/** Validates device/manual captures before using the existing TIPON save + sync function. */
function saveApplicantSignatureFromDevice(dataUrl, expectedName, requestId) {
  if (!/^[a-f0-9]{32}$/.test(String(requestId || ''))) throw new Error('Invalid signature session. Reopen Capture Signature.');
  if (typeof dataUrl !== 'string' || dataUrl.length > 1600000 || !/^data:image\/png;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl)) {
    throw new Error('Invalid signature image. Please capture the signature again.');
  }
  const bytes = Utilities.base64Decode(dataUrl.substring(dataUrl.indexOf(',') + 1));
  const pngHeader = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 33 || bytes.length > 1200000 || pngHeader.some(function(n, i) {return (bytes[i] & 255) !== n;})) {
    throw new Error('The signature must be a valid PNG image.');
  }
  function readUint32(offset) {
    return ((bytes[offset] & 255) * 16777216) + ((bytes[offset + 1] & 255) << 16) + ((bytes[offset + 2] & 255) << 8) + (bytes[offset + 3] & 255);
  }
  if (readUint32(16) !== 840 || readUint32(20) !== 480) throw new Error('Unexpected signature size. Reopen Capture Signature.');
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('Another save is in progress. Wait for it to finish before trying again.');
  try {
    const cache = CacheService.getUserCache();
    const key = 'tipon-signature-' + requestId;
    const previous = cache.get(key);
    if (previous === 'saved') return {success:true, duplicate:true};
    if (previous) throw new Error('This signature was already submitted. Check the form before starting a new capture.');
    const sheet = SpreadsheetApp.openById(APPLICANT_CAPTURE_CONFIG.spreadsheetId).getSheetByName(APPLICANT_CAPTURE_CONFIG.sheetName);
    if (!sheet) throw new Error('The applicant form was not found.');
    if (getApplicantCaptureName_(sheet) !== String(expectedName || '').trim()) {
      throw new Error('The selected applicant changed. Close this window and capture the signature for the correct applicant.');
    }
    cache.put(key, 'started', 21600);
    try {
      const result = saveApplicantSignatureCapture(dataUrl);
      if (!result || result.success !== true) throw new Error('The existing signature save did not confirm success.');
      cache.put(key, 'saved', 21600);
      return result;
    } catch (error) {
      cache.put(key, 'check-form', 21600);
      throw new Error('Save was not fully confirmed. Check the applicant form and signature copies before recapturing. ' + error.message);
    }
  } finally {lock.releaseLock();}
}
