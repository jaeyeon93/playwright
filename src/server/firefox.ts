/**
 * Copyright 2017 Google Inc. All rights reserved.
 * Modifications copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import { FFBrowser } from '../firefox/ffBrowser';
import { BrowserFetcher, BrowserFetcherOptions } from './browserFetcher';
import { DeviceDescriptors } from '../deviceDescriptors';
import { launchProcess, waitForLine } from './processLauncher';
import * as types from '../types';
import * as platform from '../platform';
import { kBrowserCloseMessageId } from '../firefox/ffConnection';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as util from 'util';
import { TimeoutError } from '../errors';
import { assert } from '../helper';
import { LaunchOptions, BrowserArgOptions, BrowserType } from './browserType';
import { ConnectOptions, LaunchType } from '../browser';
import { BrowserServer } from './browserServer';
import { Events } from '../events';
import { ConnectionTransport } from '../transport';
import { BrowserContext } from '../browserContext';

export class Firefox implements BrowserType {
  private _projectRoot: string;
  readonly _revision: string;

  constructor(projectRoot: string, preferredRevision: string) {
    this._projectRoot = projectRoot;
    this._revision = preferredRevision;
  }

  name() {
    return 'firefox';
  }

  async launch(options?: LaunchOptions & { slowMo?: number }): Promise<FFBrowser> {
    const { browserServer, transport } = await this._launchServer(options, 'local');
    const browser = await FFBrowser.connect(transport!, options && options.slowMo);
    // Hack: for typical launch scenario, ensure that close waits for actual process termination.
    browser.close = () => browserServer.close();
    (browser as any)['__server__'] = browserServer;
    return browser;
  }

  async launchServer(options?: LaunchOptions & { port?: number }): Promise<BrowserServer> {
    return (await this._launchServer(options, 'server', undefined, options && options.port)).browserServer;
  }

  async launchPersistent(userDataDir: string, options?: LaunchOptions): Promise<BrowserContext> {
    const { browserServer, transport } = await this._launchServer(options, 'persistent', userDataDir);
    const browser = await FFBrowser.connect(transport!);
    // Hack: for typical launch scenario, ensure that close waits for actual process termination.
    const browserContext = browser._defaultContext;
    browserContext.close = () => browserServer.close();
    return browserContext;
  }

  private async _launchServer(options: LaunchOptions = {}, connectionType: LaunchType, userDataDir?: string, port?: number): Promise<{ browserServer: BrowserServer, transport?: ConnectionTransport }> {
    const {
      ignoreDefaultArgs = false,
      args = [],
      dumpio = false,
      executablePath = null,
      env = process.env,
      handleSIGHUP = true,
      handleSIGINT = true,
      handleSIGTERM = true,
      timeout = 30000,
    } = options;

    const firefoxArguments = [];

    let temporaryProfileDir = null;
    if (!userDataDir) {
      userDataDir = await mkdtempAsync(path.join(os.tmpdir(), 'playwright_dev_firefox_profile-'));
      temporaryProfileDir = userDataDir;
    }
    populateProfile(userDataDir!);

    if (!ignoreDefaultArgs)
      firefoxArguments.push(...this._defaultArgs(options, userDataDir!, port || 0));
    else if (Array.isArray(ignoreDefaultArgs))
      firefoxArguments.push(...this._defaultArgs(options, userDataDir!, port || 0).filter(arg => !ignoreDefaultArgs.includes(arg)));
    else
      firefoxArguments.push(...args);

    let firefoxExecutable = executablePath;
    if (!firefoxExecutable) {
      const {missingText, executablePath} = this._resolveExecutablePath();
      if (missingText)
        throw new Error(missingText);
      firefoxExecutable = executablePath;
    }

    let browserServer: BrowserServer | undefined = undefined;
    const { launchedProcess, gracefullyClose } = await launchProcess({
      executablePath: firefoxExecutable,
      args: firefoxArguments,
      env: os.platform() === 'linux' ? {
        ...env,
        // On linux Juggler ships the libstdc++ it was linked against.
        LD_LIBRARY_PATH: `${path.dirname(firefoxExecutable)}:${process.env.LD_LIBRARY_PATH}`,
      } : env,
      handleSIGINT,
      handleSIGTERM,
      handleSIGHUP,
      dumpio,
      pipe: false,
      tempDir: temporaryProfileDir || undefined,
      attemptToGracefullyClose: async () => {
        if (!browserServer)
          return Promise.reject();
        // We try to gracefully close to prevent crash reporting and core dumps.
        // Note that it's fine to reuse the pipe transport, since
        // our connection ignores kBrowserCloseMessageId.
        const transport = new platform.WebSocketTransport(browserWSEndpoint);
        const message = { method: 'Browser.close', params: {}, id: kBrowserCloseMessageId };
        await transport.send(JSON.stringify(message));
      },
      onkill: (exitCode, signal) => {
        if (browserServer)
          browserServer.emit(Events.BrowserServer.Close, exitCode, signal);
      },
    });

    const timeoutError = new TimeoutError(`Timed out after ${timeout} ms while trying to connect to Firefox!`);
    const match = await waitForLine(launchedProcess, launchedProcess.stdout, /^Juggler listening on (ws:\/\/.*)$/, timeout, timeoutError);
    const browserWSEndpoint = match[1];
    browserServer = new BrowserServer(launchedProcess, gracefullyClose, connectionType === 'server' ? browserWSEndpoint : null);
    return { browserServer, transport: connectionType === 'server' ? undefined : new platform.WebSocketTransport(browserWSEndpoint) };
  }

  async connect(options: ConnectOptions): Promise<FFBrowser> {
    const transport = new platform.WebSocketTransport(options.wsEndpoint);
    return FFBrowser.connect(transport, options.slowMo);
  }

  executablePath(): string {
    return this._resolveExecutablePath().executablePath;
  }

  get devices(): types.Devices {
    return DeviceDescriptors;
  }

  get errors(): { TimeoutError: typeof TimeoutError } {
    return { TimeoutError };
  }

  private _defaultArgs(options: BrowserArgOptions = {}, userDataDir: string, port: number): string[] {
    const {
      devtools = false,
      headless = !devtools,
      args = [],
    } = options;
    if (devtools)
      throw new Error('Option "devtools" is not supported by Firefox');
    const userDataDirArg = args.find(arg => arg.startsWith('-profile') || arg.startsWith('--profile'));
    if (userDataDirArg)
      throw new Error('Pass userDataDir parameter instead of specifying -profile argument');
    if (args.find(arg => arg.startsWith('-juggler')))
      throw new Error('Use the port parameter instead of -juggler argument');

    const firefoxArguments = ['-no-remote'];
    if (headless)
      firefoxArguments.push('-headless');
    else
      firefoxArguments.push('-wait-for-browser');

    firefoxArguments.push(`-profile`, userDataDir);
    firefoxArguments.push('-juggler', String(port));
    firefoxArguments.push(...args);

    if (args.every(arg => arg.startsWith('-')))
      firefoxArguments.push('about:blank');
    return firefoxArguments;
  }

  _createBrowserFetcher(options: BrowserFetcherOptions = {}): BrowserFetcher {
    const downloadURLs = {
      linux: '%s/builds/firefox/%s/firefox-linux.zip',
      mac: '%s/builds/firefox/%s/firefox-mac.zip',
      win32: '%s/builds/firefox/%s/firefox-win32.zip',
      win64: '%s/builds/firefox/%s/firefox-win64.zip',
    };

    const defaultOptions = {
      path: path.join(this._projectRoot, '.local-firefox'),
      host: 'https://playwright.azureedge.net',
      platform: (() => {
        const platform = os.platform();
        if (platform === 'darwin')
          return 'mac';
        if (platform === 'linux')
          return 'linux';
        if (platform === 'win32')
          return os.arch() === 'x64' ? 'win64' : 'win32';
        return platform;
      })()
    };
    options = {
      ...defaultOptions,
      ...options,
    };
    assert(!!(downloadURLs as any)[options.platform!], 'Unsupported platform: ' + options.platform);

    return new BrowserFetcher(options.path!, options.platform!, this._revision, (platform: string, revision: string) => {
      let executablePath = '';
      if (platform === 'linux')
        executablePath = path.join('firefox', 'firefox');
      else if (platform === 'mac')
        executablePath = path.join('firefox', 'Nightly.app', 'Contents', 'MacOS', 'firefox');
      else if (platform === 'win32' || platform === 'win64')
        executablePath = path.join('firefox', 'firefox.exe');
      return {
        downloadUrl: util.format((downloadURLs as any)[platform], options.host, revision),
        executablePath
      };
    });
  }

  _resolveExecutablePath() {
    const browserFetcher = this._createBrowserFetcher();
    const revisionInfo = browserFetcher.revisionInfo();
    const missingText = !revisionInfo.local ? `Firefox revision is not downloaded. Run "npm install"` : null;
    return { executablePath: revisionInfo.executablePath, missingText };
  }
}

const mkdtempAsync = platform.promisify(fs.mkdtemp);
const writeFileAsync = platform.promisify(fs.writeFile);

const DUMMY_UMA_SERVER = 'dummy.test';
const DEFAULT_PREFERENCES = {
  // Make sure Shield doesn't hit the network.
  'app.normandy.api_url': '',
  // Disable Firefox old build background check
  'app.update.checkInstallTime': false,
  // Disable automatically upgrading Firefox
  'app.update.disabledForTesting': true,

  // Increase the APZ content response timeout to 1 minute
  'apz.content_response_timeout': 60000,

  // Prevent various error message on the console
  // jest-puppeteer asserts that no error message is emitted by the console
  'browser.contentblocking.features.standard': '-tp,tpPrivate,cookieBehavior0,-cm,-fp',


  // Enable the dump function: which sends messages to the system
  // console
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1543115
  'browser.dom.window.dump.enabled': true,
  // Disable topstories
  'browser.newtabpage.activity-stream.feeds.section.topstories': false,
  // Always display a blank page
  'browser.newtabpage.enabled': false,
  // Background thumbnails in particular cause grief: and disabling
  // thumbnails in general cannot hurt
  'browser.pagethumbnails.capturing_disabled': true,

  // Disable safebrowsing components.
  'browser.safebrowsing.blockedURIs.enabled': false,
  'browser.safebrowsing.downloads.enabled': false,
  'browser.safebrowsing.malware.enabled': false,
  'browser.safebrowsing.passwords.enabled': false,
  'browser.safebrowsing.phishing.enabled': false,

  // Disable updates to search engines.
  'browser.search.update': false,
  // Do not restore the last open set of tabs if the browser has crashed
  'browser.sessionstore.resume_from_crash': false,
  // Skip check for default browser on startup
  'browser.shell.checkDefaultBrowser': false,

  // Disable newtabpage
  'browser.startup.homepage': 'about:blank',
  // Do not redirect user when a milstone upgrade of Firefox is detected
  'browser.startup.homepage_override.mstone': 'ignore',
  // Start with a blank page about:blank
  'browser.startup.page': 0,

  // Do not allow background tabs to be zombified on Android: otherwise for
  // tests that open additional tabs: the test harness tab itself might get
  // unloaded
  'browser.tabs.disableBackgroundZombification': false,
  // Do not warn when closing all other open tabs
  'browser.tabs.warnOnCloseOtherTabs': false,
  // Do not warn when multiple tabs will be opened
  'browser.tabs.warnOnOpen': false,

  // Disable the UI tour.
  'browser.uitour.enabled': false,
  // Turn off search suggestions in the location bar so as not to trigger
  // network connections.
  'browser.urlbar.suggest.searches': false,
  // Disable first run splash page on Windows 10
  'browser.usedOnWindows10.introURL': '',
  // Do not warn on quitting Firefox
  'browser.warnOnQuit': false,

  // Do not show datareporting policy notifications which can
  // interfere with tests
  'datareporting.healthreport.about.reportUrl': `http://${DUMMY_UMA_SERVER}/dummy/abouthealthreport/`,
  'datareporting.healthreport.documentServerURI': `http://${DUMMY_UMA_SERVER}/dummy/healthreport/`,
  'datareporting.healthreport.logging.consoleEnabled': false,
  'datareporting.healthreport.service.enabled': false,
  'datareporting.healthreport.service.firstRun': false,
  'datareporting.healthreport.uploadEnabled': false,
  'datareporting.policy.dataSubmissionEnabled': false,
  'datareporting.policy.dataSubmissionPolicyAccepted': false,
  'datareporting.policy.dataSubmissionPolicyBypassNotification': true,

  // DevTools JSONViewer sometimes fails to load dependencies with its require.js.
  // This doesn't affect Puppeteer but spams console (Bug 1424372)
  'devtools.jsonview.enabled': false,

  // Disable popup-blocker
  'dom.disable_open_during_load': false,

  // Enable the support for File object creation in the content process
  // Required for |Page.setFileInputFiles| protocol method.
  'dom.file.createInChild': true,

  // Disable the ProcessHangMonitor
  'dom.ipc.reportProcessHangs': false,

  // Disable slow script dialogues
  'dom.max_chrome_script_run_time': 0,
  'dom.max_script_run_time': 0,

  // Only load extensions from the application and user profile
  // AddonManager.SCOPE_PROFILE + AddonManager.SCOPE_APPLICATION
  'extensions.autoDisableScopes': 0,
  'extensions.enabledScopes': 5,

  // Disable metadata caching for installed add-ons by default
  'extensions.getAddons.cache.enabled': false,

  // Disable installing any distribution extensions or add-ons.
  'extensions.installDistroAddons': false,

  // Disabled screenshots extension
  'extensions.screenshots.disabled': true,

  // Turn off extension updates so they do not bother tests
  'extensions.update.enabled': false,

  // Turn off extension updates so they do not bother tests
  'extensions.update.notifyUser': false,

  // Make sure opening about:addons will not hit the network
  'extensions.webservice.discoverURL': `http://${DUMMY_UMA_SERVER}/dummy/discoveryURL`,

  // Allow the application to have focus even it runs in the background
  'focusmanager.testmode': true,
  // Disable useragent updates
  'general.useragent.updates.enabled': false,
  // Always use network provider for geolocation tests so we bypass the
  // macOS dialog raised by the corelocation provider
  'geo.provider.testing': true,
  // Do not scan Wifi
  'geo.wifi.scan': false,

  // No ICC color correction. See
  // https://developer.mozilla.org/en/docs/Mozilla/Firefox/Releases/3.5/ICC_color_correction_in_Firefox.
  'gfx.color_management.mode': 0,
  'gfx.color_management.rendering_intent': 3,

  // No hang monitor
  'hangmonitor.timeout': 0,
  // Show chrome errors and warnings in the error console
  'javascript.options.showInConsole': true,

  // Disable download and usage of OpenH264: and Widevine plugins
  'media.gmp-manager.updateEnabled': false,
  // Prevent various error message on the console
  // jest-puppeteer asserts that no error message is emitted by the console
  'network.cookie.cookieBehavior': 0,

  // Do not prompt for temporary redirects
  'network.http.prompt-temp-redirect': false,

  // Disable speculative connections so they are not reported as leaking
  // when they are hanging around
  'network.http.speculative-parallel-limit': 0,

  // Do not automatically switch between offline and online
  'network.manage-offline-status': false,

  // Make sure SNTP requests do not hit the network
  'network.sntp.pools': DUMMY_UMA_SERVER,

  // Disable Flash.
  'plugin.state.flash': 0,

  'privacy.trackingprotection.enabled': false,

  // Enable Remote Agent
  // https://bugzilla.mozilla.org/show_bug.cgi?id=1544393
  'remote.enabled': true,

  // Don't do network connections for mitm priming
  'security.certerrors.mitm.priming.enabled': false,
  // Local documents have access to all other local documents,
  // including directory listings
  'security.fileuri.strict_origin_policy': false,
  // Do not wait for the notification button security delay
  'security.notification_enable_delay': 0,

  // Ensure blocklist updates do not hit the network
  'services.settings.server': `http://${DUMMY_UMA_SERVER}/dummy/blocklist/`,

  'browser.tabs.documentchannel': false,

  // Do not automatically fill sign-in forms with known usernames and
  // passwords
  'signon.autofillForms': false,
  // Disable password capture, so that tests that include forms are not
  // influenced by the presence of the persistent doorhanger notification
  'signon.rememberSignons': false,

  // Disable first-run welcome page
  'startup.homepage_welcome_url': 'about:blank',

  // Disable first-run welcome page
  'startup.homepage_welcome_url.additional': '',

  // Disable browser animations (tabs, fullscreen, sliding alerts)
  'toolkit.cosmeticAnimations.enabled': false,

  // We want to collect telemetry, but we don't want to send in the results
  'toolkit.telemetry.server': `https://${DUMMY_UMA_SERVER}/dummy/telemetry/`,
  // Prevent starting into safe mode after application crashes
  'toolkit.startup.max_resumed_crashes': -1,
};

async function populateProfile(profilePath: string) {
  const prefsJS: string[] = [];
  const userJS: string[] = [];

  for (const [key, value] of Object.entries(DEFAULT_PREFERENCES))
    userJS.push(`user_pref(${JSON.stringify(key)}, ${JSON.stringify(value)});`);

  await writeFileAsync(path.join(profilePath, 'user.js'), userJS.join('\n'));
  await writeFileAsync(path.join(profilePath, 'prefs.js'), prefsJS.join('\n'));
}
