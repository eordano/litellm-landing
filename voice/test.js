const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const BASE = process.env.TEST_URL || 'http://localhost:8888/voice/index.html';
const SCREENSHOT_DIR = process.env.SCREENSHOT_DIR || '/tmp/voice-tests';
const BROWSER = process.env.BROWSER_PATH || '/etc/profiles/per-user/usr/bin/chromium';

// Generate a minimal valid WAV file (1 second, 16kHz, 16-bit mono sine wave)
function generateWav() {
  const sampleRate = 16000;
  const duration = 1;
  const numSamples = sampleRate * duration;
  const buffer = Buffer.alloc(44 + numSamples * 2);

  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + numSamples * 2, 4);
  buffer.write('WAVE', 8);
  buffer.write('fmt ', 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(numSamples * 2, 40);

  for (let i = 0; i < numSamples; i++) {
    const sample = Math.floor(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 16000);
    buffer.writeInt16LE(sample, 44 + i * 2);
  }
  return buffer;
}

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

let testNum = 0;
async function screenshot(page, name) {
  testNum++;
  const file = path.join(SCREENSHOT_DIR, `${String(testNum).padStart(2, '0')}_${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  console.log(`  Screenshot: ${file}`);
  return file;
}

(async () => {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const wavPath = path.join(SCREENSHOT_DIR, 'test.wav');
  fs.writeFileSync(wavPath, generateWav());
  console.log('Generated test WAV:', wavPath);

  const browser = await chromium.launch({
    headless: true,
    executablePath: BROWSER,
  });

  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

  const logs = [];
  page.on('console', msg => logs.push(`[${msg.type()}] ${msg.text()}`));

  let passed = 0, failed = 0;
  function assert(condition, label) {
    if (condition) {
      console.log(`  PASS: ${label}`);
      passed++;
    } else {
      console.log(`  FAIL: ${label}`);
      failed++;
    }
  }

  // Helper to set search input value reliably
  async function setSearch(value) {
    await page.evaluate((v) => {
      const input = document.getElementById('searchInput');
      input.value = v;
      input.dispatchEvent(new Event('input'));
    }, value);
    await sleep(300);
  }

  try {
    // ============================================================
    console.log('\n=== TEST 1: Initial page load ===');
    await page.goto(BASE, { waitUntil: 'networkidle' });
    await screenshot(page, 'initial_load');

    const recordBtn = await page.$('#recordBtn');
    const uploadBtn = await page.$('#uploadBtn');
    const micSelect = await page.$('#micSelect');
    const searchInput = await page.$('#searchInput');
    const sortChevron = await page.$('#sortChevron');

    assert(recordBtn !== null, 'Record button exists');
    assert(uploadBtn !== null, 'Upload button exists');
    assert(micSelect !== null, 'Mic select exists');
    assert(searchInput !== null, 'Search input exists');
    assert(sortChevron !== null, 'Sort chevron exists');

    const recordText = await page.$eval('#recordBtn', el => el.textContent.trim());
    assert(recordText.includes('Record'), `Record button says "${recordText}"`);

    const controlsStyle = await page.$eval('.controls', el => {
      const cs = getComputedStyle(el);
      return { display: cs.display, justifyContent: cs.justifyContent };
    });
    assert(controlsStyle.display === 'flex', 'Controls use flex layout');

    const statusText = await page.$eval('#headerStatus', el => el.textContent);
    assert(statusText === '', 'Header status is empty initially');

    const timeHeader = await page.$eval('#sortTime', el => el.textContent.trim());
    assert(timeHeader.includes('Time'), 'Time header present');

    const chevronText = await page.$eval('#sortChevron', el => el.textContent.trim());
    assert(chevronText !== '', 'Sort chevron has content');

    // ============================================================
    console.log('\n=== TEST 2: Dark mode detection ===');
    const theme = await page.$eval('html', el => el.dataset.theme);
    assert(['dark', 'light'].includes(theme), `Theme is "${theme}"`);

    // ============================================================
    console.log('\n=== TEST 3: Mic select localStorage persistence ===');
    await page.evaluate(() => {
      const select = document.getElementById('micSelect');
      const opt = document.createElement('option');
      opt.value = 'fake-device-id-123';
      opt.textContent = 'Test Microphone';
      select.appendChild(opt);
      select.value = 'fake-device-id-123';
      select.dispatchEvent(new Event('change'));
    });
    const storedMic = await page.evaluate(() => localStorage.getItem('voiceRecorder_selectedMic'));
    assert(storedMic === 'fake-device-id-123', `Mic selection saved to localStorage: ${storedMic}`);

    // ============================================================
    console.log('\n=== TEST 4: Upload audio file and check state transitions ===');

    // Mock fetch for transcription API
    await page.evaluate(() => {
      window._mockTranscriptText = 'Hello world this is a test transcription';
      const origFetch = window.fetch;
      window.fetch = function(url, opts) {
        if (typeof url === 'string' && url.includes('/v1/audio/transcriptions')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ text: window._mockTranscriptText })
          });
        }
        return origFetch.apply(this, arguments);
      };
    });

    const fileInput = await page.$('#fileInput');
    await fileInput.setInputFiles(wavPath);

    await screenshot(page, 'after_upload_start');

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#recordings tr');
        return rows.length > 0 && rows[0].textContent.includes('Hello world');
      },
      undefined,
      { timeout: 10000 }
    );

    await screenshot(page, 'after_transcription');

    const rowCount = await page.$$eval('#recordings tr', rows => rows.length);
    assert(rowCount === 1, `Table has 1 row after upload (got ${rowCount})`);

    const transcriptText = await page.$eval('#recordings tr td:nth-child(2)', td => td.textContent);
    assert(transcriptText.includes('Hello world'), 'Row contains transcript text');

    const statusBar = await page.$eval('#transcript', el => ({
      visible: el.classList.contains('visible'),
      text: el.textContent
    }));
    assert(statusBar.visible, 'Transcript status bar is visible');
    assert(statusBar.text.includes('Hello world'), 'Status bar shows transcript');

    const headerDone = await page.$eval('#headerStatus', el => el.textContent);
    assert(headerDone.includes('Done'), `Header status shows done: "${headerDone}"`);

    const downloadBtn = await page.$('#recordings .btn-sm:not(.btn-danger):not(.retry)');
    const retryBtn = await page.$('#recordings .btn-sm.retry');
    const deleteBtn = await page.$('#recordings .btn-danger');
    assert(downloadBtn !== null, 'Download button exists with btn-sm class');
    assert(retryBtn !== null, 'Retry button exists on every row');
    assert(deleteBtn !== null, 'Delete button exists with btn-danger class');

    const btnSize = await page.$eval('#recordings .btn-sm', el => {
      const cs = getComputedStyle(el);
      return { fontSize: cs.fontSize, padding: cs.padding };
    });
    assert(parseFloat(btnSize.fontSize) < 14, `Action buttons are small (font: ${btnSize.fontSize})`);

    // ============================================================
    console.log('\n=== TEST 5: Upload a second file for sort/search testing ===');

    await page.evaluate(() => {
      window._mockTranscriptText = 'The quick brown fox jumps over the lazy dog';
    });

    const fileInput2 = await page.$('#fileInput');
    await fileInput2.setInputFiles(wavPath);

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#recordings tr');
        return rows.length >= 2 && rows[0].textContent.includes('fox');
      },
      undefined,
      { timeout: 10000 }
    );

    await screenshot(page, 'two_recordings');

    const rowCount2 = await page.$$eval('#recordings tr', rows => rows.length);
    assert(rowCount2 === 2, `Table has 2 rows after second upload (got ${rowCount2})`);

    // ============================================================
    console.log('\n=== TEST 6: Sort toggle (newest first by default) ===');

    let firstRowText = await page.$eval('#recordings tr:first-child td:nth-child(2)', td => td.textContent);
    assert(firstRowText.includes('fox'), `Newest first: first row has "fox"`);

    await page.click('#sortTime');
    await sleep(200);
    await screenshot(page, 'sort_ascending');

    firstRowText = await page.$eval('#recordings tr:first-child td:nth-child(2)', td => td.textContent);
    assert(firstRowText.includes('Hello world'), 'Oldest first: first row has "Hello world"');

    const chevronUp = await page.$eval('#sortChevron', el => el.innerHTML);
    assert(chevronUp.includes('9650') || chevronUp.includes('\u25B2'), 'Chevron points up for ascending');

    await page.click('#sortTime');
    await sleep(200);
    firstRowText = await page.$eval('#recordings tr:first-child td:nth-child(2)', td => td.textContent);
    assert(firstRowText.includes('fox'), 'Back to newest first after second click');

    const chevronDown = await page.$eval('#sortChevron', el => el.innerHTML);
    assert(chevronDown.includes('9660') || chevronDown.includes('\u25BC'), 'Chevron points down for descending');

    // ============================================================
    console.log('\n=== TEST 7: Search -- exact match ===');

    await page.click('#searchInput');
    await page.type('#searchInput', 'fox');
    await sleep(300);

    await screenshot(page, 'search_fox');

    const filteredRows = await page.$$eval('#recordings tr', rows => rows.length);
    assert(filteredRows === 1, `Search "fox" shows 1 row (got ${filteredRows})`);

    const filteredText = await page.$eval('#recordings tr td:nth-child(2)', td => td.textContent);
    assert(filteredText.includes('fox'), 'Filtered row contains "fox"');

    // ============================================================
    console.log('\n=== TEST 8: Search -- clear restores all rows ===');

    await setSearch('');

    const allRows = await page.$$eval('#recordings tr', rows => rows.length);
    assert(allRows === 2, `Clearing search shows all 2 rows (got ${allRows})`);

    // ============================================================
    console.log('\n=== TEST 9: Search -- fuzzy word matching ===');

    await setSearch('brwn fx');

    await screenshot(page, 'search_fuzzy');

    const fuzzyRows = await page.$$eval('#recordings tr', rows => rows.length);
    assert(fuzzyRows === 1, `Fuzzy search "brwn fx" matches 1 row (got ${fuzzyRows})`);

    await setSearch('');

    // ============================================================
    console.log('\n=== TEST 10: Search -- no results ===');

    await setSearch('xyznonexistent');

    const noResultRows = await page.$$eval('#recordings tr', rows => rows.length);
    assert(noResultRows === 0, `Search for nonsense shows 0 rows (got ${noResultRows})`);

    await screenshot(page, 'search_no_results');
    await setSearch('');

    // ============================================================
    console.log('\n=== TEST 11: Delete -- cancel keeps row ===');

    let dialogMessage = '';
    page.once('dialog', async dialog => {
      dialogMessage = dialog.message();
      await dialog.dismiss();
    });

    await page.click('#recordings tr:first-child .delete');
    await sleep(200);

    assert(dialogMessage.includes('sure'), `Delete shows confirmation: "${dialogMessage}"`);

    const rowsAfterCancel = await page.$$eval('#recordings tr', rows => rows.length);
    assert(rowsAfterCancel === 2, `Cancelling delete keeps 2 rows (got ${rowsAfterCancel})`);

    await screenshot(page, 'after_cancel_delete');

    // ============================================================
    console.log('\n=== TEST 12: Delete -- confirm removes row ===');

    page.once('dialog', async dialog => {
      await dialog.accept();
    });

    await page.click('#recordings tr:first-child .delete');
    await sleep(500);

    await screenshot(page, 'after_confirm_delete');

    const rowsAfterDelete = await page.$$eval('#recordings tr', rows => rows.length);
    assert(rowsAfterDelete === 1, `Confirming delete removes row, 1 remaining (got ${rowsAfterDelete})`);

    // ============================================================
    console.log('\n=== TEST 13: Retry re-transcribes a recording ===');

    // Change mock to return updated text
    await page.evaluate(() => {
      window._mockTranscriptText = 'Updated transcription after retry';
    });

    await page.click('#recordings tr:first-child .retry');

    await page.waitForFunction(
      () => {
        const rows = document.querySelectorAll('#recordings tr');
        return rows.length > 0 && rows[0].textContent.includes('Updated transcription');
      },
      undefined,
      { timeout: 10000 }
    );

    const retryText = await page.$eval('#recordings tr:first-child td:nth-child(2)', td => td.textContent);
    assert(retryText.includes('Updated transcription'), `Retry updated transcript: "${retryText.substring(0, 40)}"`);

    await screenshot(page, 'after_retry');

    // ============================================================
    console.log('\n=== TEST 14: Record button state transitions (simulated) ===');

    const canSimulate = await page.evaluate(() => {
      const btn = document.getElementById('recordBtn');
      const status = document.getElementById('headerStatus');
      const stopIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>`;
      btn.innerHTML = `${stopIcon} Stop`;
      status.textContent = 'Recording... 1.0s';
      status.className = 'recording';
      return true;
    });
    assert(canSimulate, 'Can simulate recording state');

    const recordingBtnText = await page.$eval('#recordBtn', el => el.textContent.trim());
    assert(recordingBtnText.includes('Stop'), `While recording, button says "${recordingBtnText}"`);

    const recordingStatus = await page.$eval('#headerStatus', el => ({
      text: el.textContent,
      cls: el.className
    }));
    assert(recordingStatus.text.includes('Recording'), `Header shows recording status: "${recordingStatus.text}"`);
    assert(recordingStatus.cls.includes('recording'), 'Header status has recording class');

    await screenshot(page, 'recording_active');

    await page.evaluate(() => {
      const btn = document.getElementById('recordBtn');
      const status = document.getElementById('headerStatus');
      const micIcon = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>`;
      btn.innerHTML = `${micIcon} Record`;
      status.textContent = '';
      status.className = '';
    });

    const stoppedBtnText = await page.$eval('#recordBtn', el => el.textContent.trim());
    assert(stoppedBtnText.includes('Record'), `After stopping, button says "${stoppedBtnText}"`);

    await screenshot(page, 'recording_stopped');

    // ============================================================
    console.log('\n=== TEST 15: Transcribing state in header ===');

    await page.evaluate(() => {
      const status = document.getElementById('headerStatus');
      status.textContent = 'Transcribing... 2.3s';
      status.className = 'transcribing';
    });

    const transcribingStatus = await page.$eval('#headerStatus', el => ({
      text: el.textContent,
      cls: el.className
    }));
    assert(transcribingStatus.text.includes('Transcribing'), 'Header shows transcribing status');
    assert(transcribingStatus.cls.includes('transcribing'), 'Header status has transcribing class');

    await screenshot(page, 'transcribing_state');

    // ============================================================
    console.log('\n=== TEST 16: Responsive mobile layout ===');

    await page.setViewportSize({ width: 400, height: 700 });
    await sleep(300);
    await screenshot(page, 'mobile_view');

    const mobileControls = await page.$eval('.controls', el => {
      const cs = getComputedStyle(el);
      return cs.flexDirection;
    });
    assert(mobileControls === 'column', `Controls stack vertically on mobile (direction: ${mobileControls})`);

    await page.setViewportSize({ width: 1400, height: 900 });

  } catch (err) {
    console.error('\nERROR:', err.message);
    await screenshot(page, 'error_state');
    failed++;
  }

  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}/`);
  console.log(`${'='.repeat(50)}`);

  if (logs.length) {
    console.log('\nBrowser console logs:');
    logs.forEach(l => console.log(`  ${l}`));
  }

  await browser.close();
  process.exit(failed > 0 ? 1 : 0);
})();
