const { ipcRenderer, desktopCapturer } = require('electron');
const { isMac } = require('jitsi-meet-electron-utils/screensharing/utils');

const { SCREEN_SHARE_EVENTS_CHANNEL, SCREEN_SHARE_EVENTS } = require('./constants');

/**
 * Renderer process component that sets up electron specific screen sharing functionality, like screen sharing
 * marker and window selection.
 * {@link ScreenShareMainHook} needs to be initialized in the main process for the always on top tracker window
 * to work.
 */
class ScreenShareRenderHook {
    /**
     * Creates a ScreenShareRenderHook hooked to jitsi meet iframe events.
     *
     * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
     */
    constructor(api) {
        this._api = api;
        this._iframe = this._api.getIFrame();
        this._PPWindowInterval = 0;
        this._isSharingPPWindow = false;
        this._mainPPWindowName = "";

        this._onScreenSharingStatusChanged = this._onScreenSharingStatusChanged.bind(this);
        this._sendCloseTrackerEvent = this._sendCloseTrackerEvent.bind(this);
        this._onScreenSharingEvent = this._onScreenSharingEvent.bind(this);
        this._onIframeApiLoad = this._onIframeApiLoad.bind(this);
        this._cleanTrackerContext = this._cleanTrackerContext.bind(this);
        this._onApiDispose = this._onApiDispose.bind(this);

        this._api.on('_willDispose', this._onApiDispose);
        this._iframe.addEventListener('load', this._onIframeApiLoad);
    }

    /**
     * Make sure that even after reload/redirect the screensharing will be available
     */
    _onIframeApiLoad() {
        const self = this;
        this._iframe.contentWindow.JitsiMeetElectron = {
            /**
             * Get sources available for screensharing. The callback is invoked
             * with an array of DesktopCapturerSources.
             *
             * @param {Function} callback - The success callback.
             * @param {Function} errorCallback - The callback for errors.
             * @param {Object} options - Configuration for getting sources.
             * @param {Array} options.types - Specify the desktop source types
             * to get, with valid sources being "window" and "screen".
             * @param {Object} options.thumbnailSize - Specify how big the
             * preview images for the sources should be. The valid keys are
             * height and width, e.g. { height: number, width: number}. By
             * default electron will return images with height and width of
             * 150px.
             */
            obtainDesktopStreams(callback, errorCallback, options = {}) {
                desktopCapturer
                .getSources(options)
                .then((sources) => callback(sources))
                .catch((error) => errorCallback(error));
            },
            showParticipantWindow() {
                ipcRenderer.send('PARTICIPANT_WINDOW_OPEN');
            },
            hideParticipantWindow() {
                ipcRenderer.send('PARTICIPANT_WINDOW_CLOSE');
            },
            updateDesktopAppHost(host) {
                ipcRenderer.send('PARTICIPANT_WINDOW_UPDATE_HOST', host);
            },
            updateCurrentLang(lang) {
                ipcRenderer.send('UPDATE_CURRENT_LANG', lang);
            },
            openWhiteBoardTracker(url) {
                ipcRenderer.send('TOGGLE_WHITE_BOARD_SCREEN', url);
                return ipcRenderer.sendSync('whiteboard-toggle');
            },
            handleHostAction(hostAction) {
                ipcRenderer.send('HANDLE_HOST_ACTION', hostAction);
            },
            getTenantFromStore(tenantURL) {
                ipcRenderer.send('GET_TENANT_FROM_STORE', tenantURL);
                return ipcRenderer.sendSync('GET_TENANT_FROM_STORE', tenantURL);
            },
            getApplicationVersion(version) {
                ipcRenderer.send('GET_APP_VERSION', version);
                return ipcRenderer.sendSync('GET_APP_VERSION', version);
            },
            screenSharingStatusChanged(event){
                if (event.on) {
                    if (event.details.sourceType === "window" 
                        && event.details.windowName 
                        && (isMac() || event.details.windowName.includes("PowerPoint"))) {
                        self._startWindowInterval();
                    }
                } else {
                    self._isScreenSharing = false;
                    if (self._PPWindowInterval) clearInterval(self._PPWindowInterval);
                }
            }
        };

        ipcRenderer.on(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);
        this._api.on('screenSharingStatusChanged', this._onScreenSharingStatusChanged);
        this._api.on('videoConferenceLeft', this._cleanTrackerContext);
    }

    /**
     * Listen for events coming on the screen sharing event channel.
     *
     * @param {Object} event - Electron event data.
     * @param {Object} data - Channel specific data.
     *
     * @returns {void}
     */
    _onScreenSharingEvent(event, { data }) {
        switch (data.name) {
            // Event send by the screen sharing tracker window when a user stops screen sharing from it.
            // Send appropriate command to jitsi meet api.
            case SCREEN_SHARE_EVENTS.STOP_SCREEN_SHARE:
                if (this._isScreenSharing) {
                    this._api.executeCommand('toggleShareScreen');
                }
                break;
            default:
                console.warn(`Unhandled ${SCREEN_SHARE_EVENTS_CHANNEL}: ${data}`);

        }
    }

    /**
     * React to screen sharing events coming from the jitsi meet api. There should be
     * a {@link ScreenShareMainHook} listening on the main process for the forwarded events.
     *
     * @param {Object} event
     *
     * @returns {void}
     */
    _onScreenSharingStatusChanged(event) {
        if (event.on) {
            this._isScreenSharing = true;
            // Send event which should open an always on top tracker window from the main process.
            ipcRenderer.send(SCREEN_SHARE_EVENTS_CHANNEL, {
                data: {
                    name: SCREEN_SHARE_EVENTS.OPEN_TRACKER
                }
            });
            if (event.details.sourceType === "window" 
                && event.detail.windowName 
                && event.detail.windowName.includes("PowerPoint")) {
                this._startWindowInterval();
            }
        } else {
            this._isScreenSharing = false;
            this._sendCloseTrackerEvent();
            if (this._PPWindowInterval) clearInterval(this._PPWindowInterval);
        }
    }

    _startWindowInterval() {
        const self = this;
        this._PPWindowInterval = setInterval(async () => {
            const windows = await desktopCapturer
                .getSources({ types: ['window'] });
            const powerPointWindow = windows.find(x => x.name.includes("PowerPoint Slide Show"));
            const mainPPWindow = windows.find(x => this._mainPPWindowName.length > 0 && x.name.includes(this._mainPPWindowName));
            if (powerPointWindow) {
                if (self._mainPPWindowName.length === 0) {
                    self._mainPPWindowName = powerPointWindow.name.match(/\[(.*)]/)[1];
                    self._iframe.contentWindow.APP.conference.replacePowerpointWindow(powerPointWindow.id);
                }
            } else if (mainPPWindow) {
                self._mainPPWindowName = "";
                self._iframe.contentWindow.APP.conference.replacePowerpointWindow(mainPPWindow.id);
            }
        }, 1000);
    }

    /**
     * Send event which should close the always on top tracker window.
     *
     * @return {void}
     */
    _sendCloseTrackerEvent() {
        ipcRenderer.send(SCREEN_SHARE_EVENTS_CHANNEL, {
            data: {
                name: SCREEN_SHARE_EVENTS.CLOSE_TRACKER
            }
        });
    }

    /**
     * Clear all event handlers related to the tracker in order to avoid any potential leaks and closes it in the event
     * that it's currently being displayed.
     *
     * @returns {void}
     */
    _cleanTrackerContext() {
        ipcRenderer.removeListener(SCREEN_SHARE_EVENTS_CHANNEL, this._onScreenSharingEvent);
        this._api.removeListener('screenSharingStatusChanged', this._onScreenSharingStatusChanged);
        this._api.removeListener('videoConferenceLeft', this._cleanTrackerContext);
        this._PPWindowInterval = 0;
        this._mainPPWindowName = "";
        this._isSharingPPWindow = false;
        this._sendCloseTrackerEvent();
    }

    /**
     * Clear all event handlers in order to avoid any potential leaks.
     *
     * NOTE: It is very important to remove the load listener only when we are sure that the iframe won't be used
     * anymore. Otherwise if we use the videoConferenceLeft event for example, when the iframe is internally reloaded
     * because of an error and then loads again we won't initialize the screen sharing functionality.
     *
     * @returns {void}
     */
    _onApiDispose() {
        this._cleanTrackerContext();
        this._api.removeListener('_willDispose', this._onApiDispose);
        this._iframe.removeEventListener('load', this._onIframeApiLoad);
    }
}

/**
 * Initializes the screen sharing electron specific functionality in the renderer process containing the
 * jitsi meet iframe.
 *
 * @param {JitsiIFrameApi} api - The Jitsi Meet iframe api object.
 */
module.exports = function setupScreenSharingRender(api) {
    return new ScreenShareRenderHook(api);
};