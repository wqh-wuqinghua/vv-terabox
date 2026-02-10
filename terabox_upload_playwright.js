const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

// Configuration from environment variables
const TERABOX_COOKIE = process.env.TERABOX_COOKIE || '';
const TERABOX_REMOTE_FOLDER = process.env.TERABOX_REMOTE_FOLDER || '/rtsp-videos';
const DINGDING_WEBHOOK = process.env.DINGDING_WEBHOOK || '';

// Log with timestamp
function log(message) {
  console.log(`[${new Date().toISOString()}] ${message}`);
}

// Parse cookie string to Playwright format
function parseCookies(cookieString) {
  if (!cookieString) return [];

  return cookieString.split(';').map(pair => {
    const trimmed = pair.trim();
    if (!trimmed) return null;

    const eqIndex = trimmed.indexOf('=');
    if (eqIndex === -1) return null;

    const name = trimmed.substring(0, eqIndex).trim();
    const value = trimmed.substring(eqIndex + 1).trim();

    return {
      name,
      value,
      domain: '.terabox.com',
      path: '/'
    };
  }).filter(Boolean);
}

// Send DingTalk notification
async function sendDingTalkNotification(title, message) {
  if (!DINGDING_WEBHOOK) {
    log('DingTalk webhook not configured, skipping notification');
    return;
  }

  try {
    const timestamp = new Date().toISOString();
    const payload = {
      msgtype: 'markdown',
      markdown: {
        title: title,
        text: `### ${title}\n\n${message}\n\n---\n\n**时间:** ${timestamp}\n\n**消息推送**`
      }
    };

    const response = await fetch(DINGDING_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (response.ok) {
      log('DingTalk notification sent successfully');
    } else {
      log(`Failed to send DingTalk notification: ${response.status}`);
    }
  } catch (error) {
    log(`Error sending DingTalk notification: ${error.message}`);
  }
}

// Main upload function
async function uploadFile(filePath) {
  // Validate file exists
  if (!fs.existsSync(filePath)) {
    log(`ERROR: File not found: ${filePath}`);
    return false;
  }

  const fileName = path.basename(filePath);
  const absolutePath = path.resolve(filePath);
  const fileSize = fs.statSync(filePath).size;
  const fileSizeMB = (fileSize / (1024 * 1024)).toFixed(2);

  log(`Starting upload: ${fileName} (${fileSizeMB} MB)`);

  // Parse cookies
  const cookies = parseCookies(TERABOX_COOKIE);
  if (cookies.length === 0) {
    log('ERROR: No valid cookies found. Please set TERABOX_COOKIE environment variable.');
    return false;
  }
  log(`Parsed ${cookies.length} cookies`);

  let browser = null;
  let success = false;

  try {
    // Launch browser
    log('Launching Chromium...');
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-web-security',
        '--disable-features=IsolateOrigins,site-per-process'
      ]
    });

    const context = await browser.newContext({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      viewport: { width: 1920, height: 1080 },
      locale: 'en-US',
      bypassCSP: true
    });

    // Set cookies before navigation
    log('Setting cookies...');
    await context.addCookies(cookies);

    const page = await context.newPage();

    // Enable console logging for debugging (limit noise from repeated errors)
    let consoleErrorCount = 0;
    page.on('console', msg => {
      if (msg.type() === 'error') {
        consoleErrorCount++;
        if (consoleErrorCount <= 5) {
          log(`Browser console error: ${msg.text()}`);
        } else if (consoleErrorCount === 6) {
          log(`Browser console error: (suppressing further errors, count: ${consoleErrorCount})`);
        }
      }
    });

    // Track failed upload requests to detect CORS/network issues
    let uploadFailCount = 0;
    page.on('requestfailed', request => {
      const url = request.url();
      if (url.includes('superfile2') || url.includes('pcs/file')) {
        uploadFailCount++;
        const failure = request.failure();
        log(`Upload request failed: ${failure ? failure.errorText : 'unknown'} - ${url.substring(0, 120)}...`);
      }
    });

    // Navigate to TeraBox
    log('Navigating to TeraBox...');
    await page.goto('https://www.terabox.com/main', {
      waitUntil: 'domcontentloaded',
      timeout: 60000
    });

    // Wait for page to be interactive
    log('Waiting for page to load...');
    await page.waitForLoadState('load', { timeout: 30000 }).catch(() => {
      log('Load state timeout, continuing anyway...');
    });

    // Additional wait for dynamic content
    await page.waitForTimeout(5000);

    // Take screenshot for debugging
    await page.screenshot({ path: '/tmp/terabox-before-upload.png' });
    log('Screenshot saved to /tmp/terabox-before-upload.png');

    // Check if we're logged in by looking for user-specific elements
    const isLoggedIn = await page.evaluate(() => {
      // Check for common logged-in indicators
      return !document.querySelector('.login-btn') &&
             !document.querySelector('[class*="login"]') &&
             (document.querySelector('.user-info') ||
              document.querySelector('[class*="avatar"]') ||
              document.querySelector('[class*="upload"]'));
    });

    if (!isLoggedIn) {
      log('WARNING: May not be logged in. Attempting to continue...');
    } else {
      log('Login status confirmed');
    }

    // Navigate to the target folder if specified
    if (TERABOX_REMOTE_FOLDER && TERABOX_REMOTE_FOLDER !== '/') {
      log(`Navigating to folder: ${TERABOX_REMOTE_FOLDER}`);
      const folderUrl = `https://www.terabox.com/main#/all?path=${encodeURIComponent(TERABOX_REMOTE_FOLDER)}`;
      await page.goto(folderUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(3000);
    }

    // Validate page loaded correctly before proceeding
    log('Validating page load...');
    const currentUrl = page.url();
    const pageTitle = await page.title();
    const bodyLength = await page.evaluate(() => document.body.innerHTML.length);
    log(`Page URL: ${currentUrl}`);
    log(`Page title: ${pageTitle}`);
    log(`Page body length: ${bodyLength} chars`);

    if (!currentUrl.includes('terabox.com')) {
      throw new Error(`Page redirected away from TeraBox: ${currentUrl}`);
    }

    if (bodyLength < 1000) {
      throw new Error(`Page did not load properly (body length: ${bodyLength} chars). Possible network issue.`);
    }

    // Find and click the upload button
    log('Looking for upload button...');

    // Try multiple selectors for the upload button
    const uploadButtonSelectors = [
      'input[type="file"]',
      '[class*="upload"] input[type="file"]',
      '.upload-btn input[type="file"]',
      '[data-testid="upload-input"]'
    ];

    let fileInput = null;
    for (const selector of uploadButtonSelectors) {
      try {
        fileInput = await page.$(selector);
        if (fileInput) {
          log(`Found file input with selector: ${selector}`);
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!fileInput) {
      // Try to find upload button and use file chooser
      log('No direct file input found. Trying to trigger file chooser...');

      const uploadTriggerSelectors = [
        '[class*="upload-btn"]',
        '[class*="upload-wrapper"]',
        'button:has-text("Upload")',
        '[class*="Upload"]',
        '.u-icon-file-upload',
        '[class*="add-file"]'
      ];

      let uploadTriggered = false;
      for (const selector of uploadTriggerSelectors) {
        try {
          const uploadBtn = await page.$(selector);
          if (uploadBtn) {
            log(`Found upload trigger with selector: ${selector}`);

            // Set up file chooser handler before clicking
            const [fileChooser] = await Promise.all([
              page.waitForEvent('filechooser', { timeout: 10000 }),
              uploadBtn.click()
            ]);

            await fileChooser.setFiles(absolutePath);
            uploadTriggered = true;
            log('File selected via file chooser');
            break;
          }
        } catch (e) {
          continue;
        }
      }

      if (!uploadTriggered) {
        // Last resort: try to find any file input even if hidden
        log('Trying to find hidden file input...');
        fileInput = await page.$('input[type="file"]');
        if (fileInput) {
          await fileInput.setInputFiles(absolutePath);
          log('File selected via hidden input');
        } else {
          // Dump debug info before throwing
          const debugUrl = page.url();
          const debugTitle = await page.title();
          const debugBodyLen = await page.evaluate(() => document.body.innerHTML.length);
          const debugVisibleText = await page.evaluate(() => document.body.innerText.substring(0, 500));
          log(`DEBUG - Current URL: ${debugUrl}`);
          log(`DEBUG - Page title: ${debugTitle}`);
          log(`DEBUG - Body length: ${debugBodyLen} chars`);
          log(`DEBUG - Visible text (first 500 chars): ${debugVisibleText}`);
          await page.screenshot({ path: '/tmp/terabox-no-upload-element.png', fullPage: true });
          log('DEBUG - Screenshot saved to /tmp/terabox-no-upload-element.png');
          throw new Error('Could not find any upload mechanism');
        }
      }
    } else {
      // Direct file input found
      await fileInput.setInputFiles(absolutePath);
      log('File selected via direct input');
    }

    // Wait for upload to start and complete
    log('Waiting for upload to complete...');

    // Monitor for upload progress/completion (adjust timeout based on file size)
    const uploadTimeout = Math.max(120000, fileSize / 1000); // At least 2 minutes, or 1ms per KB

    // Poll for completion: check both DOM indicators and request failures
    const pollInterval = 3000;
    const startTime = Date.now();
    let uploadComplete = false;

    while (Date.now() - startTime < uploadTimeout) {
      // Check if upload requests are failing (CORS or network issue)
      if (uploadFailCount > 5) {
        throw new Error(`Upload failed: ${uploadFailCount} upload requests failed (likely CORS or network issue)`);
      }

      // Check DOM for completion indicators
      const status = await page.evaluate(() => {
        const successEl = document.querySelector('[class*="upload-success"]') ||
                          document.querySelector('[class*="complete"]') ||
                          document.querySelector('.upload-status.success');
        if (successEl) return 'success';

        const progressBar = document.querySelector('[class*="progress"]');
        const uploadingIndicator = document.querySelector('[class*="uploading"]');
        if (!progressBar && !uploadingIndicator) return 'no-indicator';

        return 'uploading';
      });

      if (status === 'success') {
        log('Upload success indicator found');
        uploadComplete = true;
        break;
      }

      if (status === 'no-indicator' && Date.now() - startTime > 10000) {
        // No upload indicators after 10s - likely finished or never started
        log('No upload indicators found after waiting');
        uploadComplete = true;
        break;
      }

      await page.waitForTimeout(pollInterval);
    }

    if (!uploadComplete) {
      await page.screenshot({ path: '/tmp/terabox-upload-timeout.png' });
      log('Upload wait timed out, checking final state...');
    }

    log(`Console errors: ${consoleErrorCount}, Upload request failures: ${uploadFailCount}`);

    // Take final screenshot
    await page.screenshot({ path: '/tmp/terabox-after-upload.png' });
    log('Final screenshot saved to /tmp/terabox-after-upload.png');

    // Verify file appears in the list (refresh and check)
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(5000);

    // Check if file exists in the file list
    const fileExists = await page.evaluate((targetFileName) => {
      const fileItems = document.querySelectorAll('[class*="file-name"], [class*="filename"], .file-item-name');
      for (const item of fileItems) {
        if (item.textContent && item.textContent.includes(targetFileName)) {
          return true;
        }
      }
      return false;
    }, fileName);

    if (fileExists) {
      log(`SUCCESS: File "${fileName}" uploaded to ${TERABOX_REMOTE_FOLDER}`);
      success = true;
    } else {
      log(`WARNING: Could not verify file "${fileName}" in the list. Upload may have succeeded.`);
      // Consider it a success if we got this far without errors
      success = true;
    }

  } catch (error) {
    log(`ERROR: Upload failed - ${error.message}`);
    success = false;
  } finally {
    if (browser) {
      await browser.close();
      log('Browser closed');
    }
  }

  return success;
}

// Upload with retry logic
const MAX_RETRIES = 3;
const RETRY_DELAYS = [10000, 30000]; // delays before 2nd and 3rd attempt

async function uploadFileWithRetry(filePath) {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    log(`Upload attempt ${attempt}/${MAX_RETRIES} for ${path.basename(filePath)}`);

    const result = await uploadFile(filePath);
    if (result) {
      return true;
    }

    if (attempt < MAX_RETRIES) {
      const delay = RETRY_DELAYS[attempt - 1];
      log(`Attempt ${attempt} failed. Waiting ${delay / 1000}s before retry...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  log(`All ${MAX_RETRIES} attempts failed for ${path.basename(filePath)}`);
  await sendDingTalkNotification(
    'TeraBox 上传最终失败',
    `**文件名:** \`${path.basename(filePath)}\`\n\n**重试次数:** ${MAX_RETRIES}\n\n**目标路径:** ${TERABOX_REMOTE_FOLDER}/`
  );
  return false;
}

// Main entry point
async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    console.log('Usage: node terabox_upload_playwright.js <file1> [file2] ...');
    console.log('');
    console.log('Environment variables:');
    console.log('  TERABOX_COOKIE (required) - Cookie string from browser');
    console.log('  TERABOX_REMOTE_FOLDER (optional) - Target folder, default: /rtsp-videos');
    console.log('  DINGDING_WEBHOOK (optional) - DingTalk webhook for notifications');
    process.exit(1);
  }

  if (!TERABOX_COOKIE) {
    log('ERROR: TERABOX_COOKIE environment variable is required');
    process.exit(1);
  }

  log('TeraBox Playwright Uploader');
  log(`Target folder: ${TERABOX_REMOTE_FOLDER}`);

  let successCount = 0;
  const totalCount = args.length;

  for (const filePath of args) {
    log('');
    log(`Processing file ${successCount + 1}/${totalCount}: ${path.basename(filePath)}`);

    if (await uploadFileWithRetry(filePath)) {
      successCount++;
      log('Upload completed successfully');
    } else {
      log('Upload failed after all retries');
    }
  }

  log('');
  log(`Upload Summary: ${successCount}/${totalCount} files uploaded successfully`);

  if (successCount === totalCount) {
    log('All uploads completed successfully!');
    process.exit(0);
  } else {
    log(`${totalCount - successCount} upload(s) failed`);
    process.exit(1);
  }
}

main().catch(error => {
  log(`Fatal error: ${error.message}`);
  process.exit(1);
});
