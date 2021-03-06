/*
 * Captures metrics specific to the Windows operating system - for example, non-identifying keyboard metrics,
 * activation and deactivation of top-level windows, etc.
 *
 * Copyright 2017 Raising the Floor - International
 *
 * Licensed under the New BSD license. You may not use this file except in
 * compliance with this License.
 *
 * The R&D leading to these results received funding from the
 * Department of Education - Grant H421A150005 (GPII-APCP). However,
 * these results do not necessarily represent the policy of the
 * Department of Education, and you should not assume endorsement by the
 * Federal Government.
 *
 * You may obtain a copy of the License at
 * https://github.com/GPII/universal/blob/master/LICENSE.txt
 */

"use strict";

var ref = require("ref");
var fluid = require("gpii-universal"),
    path = require("path");

var gpii = fluid.registerNamespace("gpii"),
    windows = fluid.registerNamespace("gpii.windows");
fluid.registerNamespace("gpii.windows.metrics");

require("../../WindowsUtilities/WindowsUtilities.js");
require("../../windowMessages");
require("../../displaySettingsHandler");

fluid.defaults("gpii.windowsMetrics", {
    gradeNames: ["fluid.modelComponent", "fluid.contextAware", "gpii.metrics"],
    contextAwareness: {
        platform: {
            checks: {
                test: {
                    contextValue: "{gpii.contexts.test}",
                    gradeNames: "gpii.windowsMetrics.test"
                },
                windows: {
                    contextValue: "{gpii.contexts.windows}",
                    gradeNames: "gpii.windowsMetrics.windows"
                }
            }
        }
    },
    listeners: {
        "onDestroy.stopMetrics": "{that}.events.onStopMetrics",
        "{gpii.eventLog}.events.onCreate": [{
            func: "{that}.logVersions",
            priority: "last"
        },
        {
            func: "{that}.logSystemInfo",
            priority: "last"
        }],
        "onStartMetrics.application": "{that}.startApplicationMetrics",
        "onStopMetrics.application": "{that}.stopApplicationMetrics",
        "onStartMetrics.input": "{that}.startInputMetrics",
        "onStopMetrics.input": "{that}.stopInputMetrics",
        "{gpii.windows.messages}.events.onMessage": {
            funcName: "gpii.windows.metrics.windowMessage",
            // that, hwnd, msg, wParam, lParam
            args: [ "{that}", "{arguments}.0", "{arguments}.1", "{arguments}.2", "{arguments}.3" ]
        },
        "onInactive.input": {
            funcName: "gpii.windows.metrics.userInactive",
            args: [ "{that}" ]
        }
    },
    invokers: {
        logMetric: {
            func: "{eventLog}.logEvent",
            args: ["metrics", "{arguments}.0", "{arguments}.1"]
        },
        logVersions: {
            funcName: "gpii.windows.metrics.logVersions",
            args: ["{that}"]
        },
        logSystemInfo: {
            funcName: "gpii.windows.metrics.logSystemInfo",
            args: ["{that}"]
        },
        startApplicationMetrics: {
            funcName: "gpii.windows.metrics.startApplicationMetrics",
            args: ["{that}"]
        },
        stopApplicationMetrics: {
            funcName: "gpii.windows.metrics.stopApplicationMetrics",
            args: ["{that}"]
        },
        startInputMetrics: {
            funcName: "gpii.windows.metrics.startInputMetrics",
            args: ["{that}"]
        },
        stopInputMetrics: {
            funcName: "gpii.windows.metrics.stopInputMetrics",
            args: ["{that}"]
        },
        windowActivated: {
            funcName: "gpii.windows.metrics.windowActivated",
            args: ["{that}", "{eventLog}", "{arguments}.0"] // window handle (hwnd)
        },
        windowCreated: {
            funcName: "gpii.windows.metrics.windowCreated",
            args: ["{that}", "{arguments}.0", "{arguments}.1"] // window handle (hwnd)
        },
        windowDestroyed: {
            funcName: "gpii.windows.metrics.windowDestroyed",
            args: ["{that}", "{arguments}.0", "{arguments}.1"] // window handle (hwnd)
        },
        startMessages: "{gpii.windows.messages}.start({that})",
        stopMessages: "{gpii.windows.messages}.stop({that})",
        getMessageWindow: "{gpii.windows.messages}.getWindowHandle()"
    },
    members: {
        config: {
            application: {},
            input: {
                // Minimum typing session time, in milliseconds.
                minSession: 30000,
                // The time a session will last with no activity, in milliseconds.
                sessionTimeout: 60000,
                // Minimum number of keys in a typing session time.
                minSessionKeys: 10,
                // Milliseconds of no input to assume inactive
                inactiveTime: 300000
            }
        },
        state: {
            application: {
                // List of windows that are known to exist.
                knownWindows: {},
                // The running applications
                runningApplications: {}
            },
            input: {
                lastKeyTime: 0,
                // Timestamp of typing session start.
                sessionStart: null,
                // Number of keys in the typing session.
                keyCount: 0,
                // Number of special keys
                specialCount: 0,
                // Mouse position
                lastPos: null,
                distance: 0
            }
        },
        keyboardHookHandle: null,
        mouseHookHandle: null
    },
    durationEvents: {
        "app-active": "app-inactive"
    }
});

fluid.defaults("gpii.installID.windows", {
    invokers: {
        getMachineID: "gpii.windows.getMachineID"
    }
});

/**
 * Gets the machine ID - something that uniquely identifies this machine.
 *
 * This relies on the MachineGUID, which is generated when Windows is installed or when a cloned image is deployed
 * in the recommended way using sysprep.
 *
 * @return {String} The machine ID.
 */
windows.getMachineID = function () {
    var machineID = windows.readRegistryKey(
        "HKEY_LOCAL_MACHINE", "64:SOFTWARE\\Microsoft\\Cryptography", "MachineGuid", "REG_SZ").value;
    return machineID;
};

/**
 * Logs the version of this, the gpii-app, gpii-windows, and gpii-universal modules.
 *
 * The logging of this module can be used to identify changes in the data structures, independent of the other releases.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.logVersions = function (that) {
    var data = {};

    var modules = [ "windowsMetrics", "gpii-app", "gpii-windows", "gpii-universal" ];

    fluid.each(modules, function (moduleName) {
        var version;
        if (fluid.module.modules[moduleName]) {
            var packageData = fluid.require("%" + moduleName + "/package.json");
            version = packageData.version;
        } else {
            version = "none";
        }
        data[moduleName] = version;
    });

    that.logMetric("version", data);
};

/**
 * Logs information about the system, consisting of:
 *
 * - CPU & memory.
 * - Windows version.
 * - System name and manufacturer.
 *
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.logSystemInfo = function (that) {
    var os = require("os");

    var oneGB = 0x40000000;

    var cpus = os.cpus();
    var resolution = windows.display.getScreenResolution();
    var desktop = windows.display.getDesktopSize();
    var scale = (resolution.width / desktop.width).toPrecision(3);

    var data = {
        cpu: cpus[0].model,
        cores: cpus.length,
        memory: (os.totalmem / oneGB).toPrecision(2),

        resolution: resolution.width + "x" + resolution.height,
        scale: scale,

        osRelease: os.release(),
        osEdition: windows.readRegistryKey("HKEY_LOCAL_MACHINE",
            "64:SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion", "ProductName", "REG_SZ").value,
        osBits: windows.isWow64() || os.arch() === "x64" ? "64" : "32",

        systemMfr: windows.readRegistryKey("HKEY_LOCAL_MACHINE",
            "64:SYSTEM\\CurrentControlSet\\Control\\SystemInformation", "SystemManufacturer", "REG_SZ").value,
        systemName: windows.readRegistryKey("HKEY_LOCAL_MACHINE",
            "64:SYSTEM\\CurrentControlSet\\Control\\SystemInformation", "SystemProductName", "REG_SZ").value
    };

    that.logMetric("system-info", data);
};

/**
 * Check if the currently active pid+exe has been seen before. If not, log it as an application launch.
 * Called when a window has been activated.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {WindowInfo} windowInfo The new window.
 */
windows.metrics.checkNewApplication = function (that, windowInfo) {
    var runningApplications = that.state.application.runningApplications;

    // pid might have been re-used.
    var oldApp = runningApplications[windowInfo.pid];
    var isNew = !oldApp || oldApp.exe !== windowInfo.exe;

    if (isNew) {
        var data = {
            exe: windows.metrics.genericisePath(windowInfo.exe),
            pid: windowInfo.pid,
            windowClass: windowInfo.className
        };

        that.logMetric("app-launch", data);

        runningApplications[windowInfo.pid] = { exe: windowInfo.exe };
    }
};

/**
 * Begin monitoring the application launches and active windows.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.startApplicationMetrics = function (that) {
    that.startMessages();

    // Tell Windows to send WM_SHELLHOOKMESSAGE.
    gpii.windows.user32.RegisterShellHookWindow(that.getMessageWindow());
};

/**
 * Stops collecting the application metrics.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.stopApplicationMetrics = function (that) {
    that.stopMessages();
};

/**
 * Logs the application active metric - how long an application has been active for.
 * Called when a new window is being activated or deactivated, while currentProcess refers to the application losing
 * focus.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {WindowInfo} windowInfo The activated window.
 * @param {Boolean} activated true if the window is being activated, false if it's deactivated
 */
windows.metrics.logAppActivate = function (that, windowInfo, activated) {
    var data = {
        exe: windows.metrics.genericisePath(windowInfo.exe),
        window: windowInfo.pid.toString(36) + "-" + windowInfo.hwnd.toString(36),
        windowClass: windowInfo.className
    };
    that.logMetric(activated ? "app-active" : "app-inactive", data);
};

/**
 * Extracts a RAWINPUTMOUSE or a RAWINPUTKEYBOARD from a received lParam.
 *
 * @param {Buffer} lParam A handle to a RAWINPUT structure received from the
 *  system within a WM_INPUT message.
 * @return {Promise} Promise holding either a RAWINPUTMOUSE or a RAWINPUTKEYBOARD, depending on the
 *  contents of the lParam handle. In case of error the promise is rejected with and error of the
 *  following kind: {isError:true, returnCode: -1, errorCode: GetLastError()}.
 */
windows.metrics.getRawInputData = function (lParam) {
    var promise = fluid.promise();

    var dataSz = ref.alloc(windows.types.UINT, 0);
    var res = windows.user32.GetRawInputData(
        lParam,
        windows.API_constants.RID_INPUT,
        ref.NULL,
        dataSz,
        windows.RAWINPUTHEADER.size
    );

    if (res === 0) {
        var rawInputBuf = Buffer.alloc(dataSz.deref());
        res = windows.user32.GetRawInputData(
            lParam,
            windows.API_constants.RID_INPUT,
            rawInputBuf,
            dataSz,
            windows.RAWINPUTHEADER.size
        );
        var rawInput = ref.get(rawInputBuf, 0, windows.RAWINPUTKEYBOARD);

        if (rawInput.header.dwType === windows.API_constants.RIM_TYPEMOUSE) {
            var rawMouse = ref.get(rawInputBuf, 0, windows.RAWINPUTMOUSE);
            promise.resolve(rawMouse);
        } else {
            promise.resolve(rawInput);
        }
    } else {
        var errCode = windows.kernel32.GetLastError();
        promise.reject(windows.win32error("Failed to get GetRawInputData.", -1, errCode));
    }

    return promise;
};

/**
 * Function that handles the WM_INPUT message received with event information
 * from the registered devices.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {Object} lParam Message specific data.
 */
windows.metrics.handleWMINPUT = function (that, lParam) {
    windows.metrics.userInput(that);

    var pRawInput = windows.metrics.getRawInputData(lParam);

    pRawInput.then(function (rawInput) {
        if (rawInput.header.dwType === windows.API_constants.RIM_TYPEKEYBOARD) {
            // Ignore injected keys
            if (rawInput.header.hDevice !== 0 && rawInput.keyboard.Message === windows.API_constants.WM_KEYUP) {
                var keyValue = windows.user32.MapVirtualKeyW(rawInput.keyboard.VKey, windows.API_constants.MAPVK_VK_TO_CHAR);
                var specialKey = windows.metrics.specialKeys[rawInput.keyboard.VKey];

                if (specialKey || keyValue) {
                    var timestamp = windows.user32.GetMessageTime();
                    windows.metrics.recordKeyTiming(that, timestamp, specialKey, String.fromCharCode(keyValue));
                }
            }
        } else if (rawInput.header.dwType === windows.API_constants.RIM_TYPEMOUSE) {
            var relevantMouseEvent =
                // Is a relevant event
                ( ( rawInput.mouse.usButtonFlags & (
                        windows.API_constants.RI_MOUSE_WHEEL |
                        windows.API_constants.RI_MOUSE_LEFT_BUTTON_UP |
                        windows.API_constants.RI_MOUSE_RIGHT_BUTTON_UP
                    )
                ) !== 0) ||
                // Mouse just moved
                rawInput.mouse.usButtonFlags === 0;

            if (relevantMouseEvent && rawInput.header.hDevice !== 0) {
                var wheelDistance = rawInput.mouse.usButtonData;
                var wheelDirection = 0;
                var button = 0;

                if ((rawInput.mouse.usButtonFlags & windows.API_constants.RI_MOUSE_WHEEL) !== 0) {
                    // Unsigned to signed
                    if (wheelDistance >= 0x8000) {
                        wheelDistance -= 0x10000;
                    }
                    if (wheelDistance >= 0) {
                        wheelDirection = 1;
                    } else {
                        wheelDirection = -1;
                    }
                    button = "W";
                } else if ((rawInput.mouse.usButtonFlags & windows.API_constants.RI_MOUSE_LEFT_BUTTON_UP) !== 0) {
                    button = 1;
                } else if ((rawInput.mouse.usButtonFlags & windows.API_constants.RI_MOUSE_RIGHT_BUTTON_UP) !== 0) {
                    button = 2;
                }

                windows.metrics.recordMouseEvent(
                    that,
                    button,
                    {
                        x: rawInput.mouse.lLastX,
                        y: rawInput.mouse.lLastY,
                        wheel: wheelDirection
                    }
                );
            }
        }
    }, function (err) {
        fluid.log(err);
    });
};

/**
 * Called when an event has been received by the message window.
 *
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Number} hwnd The window handle of the message window.
 * @param {Number|String} msg The message identifier.
 * @param {Number} wParam Message specific data.
 * @param {Object} lParam Additional message specific data (passed, but not used).
 */
windows.metrics.windowMessage = function (that, hwnd, msg, wParam, lParam) {
    var lParamNumber = (lParam && lParam.address) ? lParam.address() : lParam || 0;
    switch (msg) {
    case windows.API_constants.WM_INPUT:
        // Handle the WM_INPUT message holding devices input information
        windows.metrics.handleWMINPUT(that, lParam);
        break;

    case windows.API_constants.WM_SHELLHOOK:
        // Run the code in the next tick so this function can return soon, as it's a window procedure.
        process.nextTick(windows.metrics.shellMessage, that, wParam, lParamNumber);
        break;

    case windows.API_constants.WM_POWERBROADCAST:
        if (wParam === windows.API_constants.PBT_APMSUSPEND) {
            // About to suspend
            that.logMetric("power-suspend");
            that.events.onInactive.fire({sleep: true});
        } else if (wParam === windows.API_constants.PBT_APMRESUMEAUTOMATIC) {
            // Woke up. (onActive will be fired when there's input)
            that.logMetric("power-resume");
        }
        break;

    default:
        if (windows.metrics.settingsMessages.indexOf(msg) > -1) {
            process.nextTick(windows.metrics.configMessage, that, hwnd, msg, wParam, lParamNumber);
        }
        break;
    }
};

/**
 * Handles the WM_SHELLHOOKMESSAGE system notification.
 * https://docs.microsoft.com/en-us/windows/desktop/api/winuser/nf-winuser-registershellhookwindow
 *
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Number} message The type of shell hook message.
 * @param {Number} hwnd The window handle the message is about.
 */
windows.metrics.shellMessage = function (that, message, hwnd) {
    switch (message) {
    case windows.API_constants.HSHELL_WINDOWACTIVATED:
    case windows.API_constants.HSHELL_RUDEAPPACTIVATED:
        that.windowActivated(hwnd);
        break;
    case windows.API_constants.HSHELL_WINDOWCREATED:
        if (hwnd) {
            that.windowCreated(hwnd);
        }
        break;
    case windows.API_constants.HSHELL_WINDOWDESTROYED:
        that.windowDestroyed(hwnd);
        break;
    }
};

// The interesting messages for metrics that are received when a setting has changed.
windows.metrics.settingsMessages = [
    windows.API_constants.WM_SYSCOLORCHANGE,
    windows.API_constants.WM_INPUTLANGCHANGE,
    windows.API_constants.WM_DISPLAYCHANGE,
    windows.API_constants.WM_THEMECHANGED,
    windows.API_constants.WM_SETTINGCHANGE
];

/**
 * Log a configuration related windows message. Called when a message in windows.metrics.settingsMessages has been
 * received.
 *
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Number} hwnd The window handle of the message window.
 * @param {Number} msg The message identifier.
 * @param {Number} wParam Message specific data.
 * @param {Number} lParam Additional message specific data.
 */
windows.metrics.configMessage = function (that, hwnd, msg, wParam, lParam) {
    var eventData = {
        wp: wParam,
        lp: lParam,
        msg: msg
    };

    // Get the constant name (eg, "WM_DISPLAYCHANGE")
    eventData.msg = fluid.find(windows.API_constants, function (value, key) {
        if (value === msg && key.startsWith("WM_")) {
            return key;
        }
    });

    var eventName;

    switch (msg) {
    case windows.API_constants.WM_SETTINGCHANGE:
        // "when the SystemParametersInfo function changes a system-wide setting or when policy settings have changed"
        // https://docs.microsoft.com/en-us/windows/desktop/winmsg/wm-settingchange
        var spiAction = gpii.windows.spi.actionsLookup[wParam];
        if (spiAction) {
            eventName = "spi";
            eventData.action = spiAction;
        }
        break;

    case windows.API_constants.WM_DISPLAYCHANGE:
        // "when the display resolution has changed"
        // https://docs.microsoft.com/en-gb/windows/desktop/gdi/wm-displaychange
        eventName = "resolution";
        eventData.width = windows.loWord(lParam);
        eventData.height = windows.hiWord(lParam);
        // Assume it's always 32bpp, unless specified.
        if (wParam !== 32) {
            eventData.bpp = wParam;
        }
        break;

    default:
        break;
    }

    eventName = eventName ? "config." + eventName : "config";
    that.logMetric(eventName, eventData);
};


/**
 * Called when a window has been created, or an unknown window has been activated.
 *
 * Adds the window to the list of known windows along with the process, so when the window is destroyed it can be
 * determined which process it belonged to.
 *
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Number} hwnd The window handle.
 */
windows.metrics.windowCreated = function (that, hwnd) {
    var state = that.state.application;

    var windowInfo = state.knownWindows[hwnd];

    if (!windowInfo) {
        windowInfo = windows.metrics.getWindowInfo(hwnd);
        state.knownWindows[hwnd] = windowInfo;
    }

    windows.metrics.checkNewApplication(that, windowInfo);
};

/**
 * Called when a window has been destroyed.
 *
 * Logs the app-close event, if the process terminates soon.
 *
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Number} hwnd The window handle (no longer valid).
 */
windows.metrics.windowDestroyed = function (that, hwnd) {
    var state = that.state.application;

    // Use the stored info, because the window has been destroyed and the handle is invalid.
    var windowInfo = state.knownWindows[hwnd];

    if (windowInfo) {
        var runningApp = state.runningApplications[windowInfo.pid];
        if (runningApp && !runningApp.closing) {
            // Wait a bit for the process to close.
            windows.waitForProcessTermination(windowInfo.pid, {pollDelay: 1000, timeout: 20000}).then(function () {
                var data = {
                    exe: windows.metrics.genericisePath(windowInfo.exe),
                    pid: windowInfo.pid,
                    windowClass: windowInfo.className
                };
                that.logMetric("app-close", data);
                delete state.runningApplications[windowInfo.pid];
            }, function () {
                // timeout - the process isn't closing after all.
                runningApp.closing = false;
            });

            // Don't log the close again, for multi-window processes.
            runningApp.closing = true;
        }
        delete state.knownWindows[hwnd];
    }
};

/**
 * Called when a window has been activated.
 * @param {Component} that The gpii.windowsMetrics component.
 * @param {Component} eventLog The gpii.eventLog component.
 * @param {Number} hwnd The window handle.
 */
windows.metrics.windowActivated = function (that, eventLog, hwnd) {
    var state = that.state.application;

    if (!hwnd) {
        hwnd = windows.user32.GetForegroundWindow();
    }

    if (hwnd !== state.activeWindow) {
        // Record the window that's losing focus.
        var oldWindowInfo = state.knownWindows[state.activeWindow];
        if (oldWindowInfo) {
            windows.metrics.logAppActivate(that, oldWindowInfo, false);
            eventLog.setState("app", null);
        }
        // Record the window that's being activated.
        if (hwnd) {
            var windowInfo = state.knownWindows[hwnd];
            if (!windowInfo) {
                // The window isn't known - it may have been created before this process.
                that.windowCreated(hwnd);
                windowInfo = state.knownWindows[hwnd];
            }

            if (windowInfo) {
                that.state.application.currentProcess = {
                    pid: windowInfo.pid,
                    exe: windows.metrics.genericisePath(windowInfo.exe)
                };

                eventLog.setState("app", windowInfo.pid === process.pid ? "active" : null);
                windows.metrics.logAppActivate(that, windowInfo, true);
            }
        }
    }
    state.activeWindow = hwnd;
};

/**
 * Information about a window.
 * @typedef {Object} WindowInfo
 * @property {Number} hwnd The window handle.
 * @property {String} className The name of the window class.
 * @property {Number} pid The process ID.
 * @property {String} exe The executable name (lower-cased, without the directory)
 */

/**
 * Gets some pieces of information about a window.
 *
 * @param {Number} hwnd The window handle.
 * @return {WindowInfo} Information about the window.
 */
windows.metrics.getWindowInfo = function (hwnd) {
    var windowInfo = {
        hwnd: hwnd,
        pid: windows.getWindowProcessId(hwnd),
        exe: null,
        className: null
    };

    if (windowInfo.pid) {
        windowInfo.exe = windows.getProcessPath(windowInfo.pid);
    } else {
        windowInfo.pid = 0;
    }

    if (!windowInfo.exe) {
        windowInfo.exe = "unknown-" + windowInfo.pid.toString(16);
    }

    var classBuffer = Buffer.alloc(0xff);
    var len = windows.user32.GetClassNameW(hwnd, classBuffer, classBuffer.length);
    if (len > 0) {
        windowInfo.className = windows.stringFromWideChar(classBuffer);
    }

    // For UWP apps, the main window doesn't belong to the real process; the application window is a child.
    var isAppFrame = windowInfo.className === "ApplicationFrameWindow";
    if (isAppFrame && windowInfo.exe && windowInfo.exe.toLowerCase().endsWith("applicationframehost.exe")) {
        classBuffer = Buffer.alloc(0xff);
        var child = windows.enumerateWindows(hwnd, function (hwndChild) {
            if (windows.user32.GetClassNameW(hwndChild, classBuffer, classBuffer.length)) {
                var cls = windows.stringFromWideChar(classBuffer);
                return cls === "Windows.UI.Core.CoreWindow" ? hwndChild : undefined;
            }
        });
        if (child) {
            // Use the info from the child window.
            windowInfo = windows.metrics.getWindowInfo(child);
            windowInfo.hwnd = hwnd;
        }
    }

    return windowInfo;
};

/**
 * The environment variables used by genericisePath() to translate real paths into paths with environment variables.
 * These are compared with the start of a path, in the given order.
 * @type {Array<String>}
 */
windows.metrics.pathEnvironmentNames = [
    "SystemRoot",              // C:\Windows
    "CommonProgramFiles",      // C:\Program Files\Common Files
    "CommonProgramFiles(x86)", // C:\Program Files (x86)\Common Files
    "ProgramFiles(x86)",       // C:\Program Files (x86)
    "ProgramFiles",            // C:\Program Files
    "APPDATA",                 // C:\Users\vagrant\AppData\Roaming
    "TEMP",                    // C:\Users\vagrant\AppData\Local\Temp
    "LOCALAPPDATA",            // C:\Users\vagrant\AppData\Local
    "HOME",                    // C:\Users\vagrant
    "USERPROFILE",             // C:\Users\vagrant
    "PUBLIC",                  // C:\Users\Public
    "ProgramData",             // C:\ProgramData
    "ALLUSERSPROFILE"          // C:\ProgramData
];

/**
 * Takes a real path, and attempts to produce a generic looking path which is prefixed with a well-known environment
 * variable instead of the real path.
 *
 * For example, "C:\Users\yourname\some-file" becomes "%HOME%\some-file"
 *
 * This is mostly to stop the user name being leaked (eg, `c:\Users\<username>\`), but also makes certain paths look the
 * same when from other systems with different names (such as `C:\Archivos de programa` and `C:\Program Files`)
 *
 * @param {String} rawPath The path.
 * @param {Object} env [optional] The environment map (default: process.env)
 * @return {String} The path, either as-is or with a matching environment variable name replacing its value.
 */
windows.metrics.genericisePath = function (rawPath, env) {
    env = env || process.env;
    if (!rawPath) {
        return "";
    }

    var pathMatch = path.normalize(rawPath).toLowerCase();

    var envFound = fluid.find(windows.metrics.pathEnvironmentNames, function (envName) {
        if (env[envName]) {
            var envValue = path.normalize(env[envName]).replace(/\\+$/, "");
            if (pathMatch.startsWith(envValue.toLowerCase())) {
                return {
                    name: envName,
                    value: envValue
                };
            }
        }
    });

    var pathTogo;
    if (envFound) {
        var ending = path.normalize(rawPath).substr(envFound.value.length);
        pathTogo = path.join("%" + envFound.name + "%", ending);
    } else {
        pathTogo = rawPath;
    }

    return pathTogo;
};

/**
 * Starts the input metrics.
 *
 * This register devices that supply RAW input data to the process using the raw input Windows API. This makes
 * the system send a WM_INPUT message to this process each time the mouse is moved/clicked or a keyboard key is
 * pressed. API overview: https://docs.microsoft.com/en-us/windows/win32/inputdev/raw-input
 *
 * This comes with the following limitations:
 * - The process needs a window-message loop. Fortunately, Electron has one so this means it will only work if running
 *   via gpii-app.
 * - Anti-virus software may question this.
 *
 * The environment variable GPII_NO_INPUT_METRICS can be set to disable input metrics.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.startInputMetrics = function (that) {
    windows.metrics.stopInputMetrics(that);

    var disable = false;
    if (process.env.GPII_NO_INPUT_METRICS) {
        disable = "GPII_NO_INPUT_METRICS";
    } else if (that.options.siteConfig.disable || that.options.siteConfig.disableInput) {
        disable = "siteConfig";
    };

    if (disable) {
        fluid.log(fluid.logLevel.WARN, "Input metrics disabled by " + disable);
        that.logMetrics("input-disabled", { reason: disable } );
    } else if (process.versions.electron || that.options.forceInputMetrics) {
        var messageWindow = that.getMessageWindow();
        var keyboard = new windows.RAWINPUTDEVICE();

        keyboard.dwFlags = windows.API_constants.RIDEV_INPUTSINK;
        keyboard.usUsagePage = 1;
        // Keyboard code
        keyboard.usUsage = 6;
        keyboard.hwndTarget = messageWindow;

        var mouse = new windows.RAWINPUTDEVICE();

        mouse.dwFlags = windows.API_constants.RIDEV_INPUTSINK;
        mouse.usUsagePage = 1;
        // Mouse code
        mouse.usUsage = 2;
        mouse.hwndTarget = messageWindow;

        var devices = Buffer.alloc(windows.RAWINPUTDEVICE.size * 2);
        mouse.ref().copy(devices, 0, 0, windows.RAWINPUTDEVICE.size);
        keyboard.ref().copy(devices, windows.RAWINPUTDEVICE.size, 0, windows.RAWINPUTDEVICE.size);

        windows.user32.RegisterRawInputDevices(devices, 2, windows.RAWINPUTDEVICE.size);
    } else {
        // The keyboard hook's ability to work is a side-effect of running with electron.
        fluid.log(fluid.logLevel.WARN, "Input metrics not available without Electron.");
    }
};

/**
 * Disables the key stroke metrics.
 *
 * Removes the low-level keyboard hook from the system, and sends the last timings to the log.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.stopInputMetrics = function (that) {
    var state = that.state.input;
    if (state) {
        if (state.inactivityTimer) {
            clearTimeout(state.inactivityTimer);
            state.inactivityTimer = null;
        }
    }

    // Unregister RAWINPUT devices
    var keyboard = new windows.RAWINPUTDEVICE();

    // Flags for removing the keyboard device
    keyboard.dwFlags =
        windows.API_constants.RIDEV_INPUTSINK |
        windows.API_constants.RIDEV_REMOVE;
    keyboard.usUsagePage = 1;
    keyboard.usUsage = 6;
    keyboard.hwndTarget = 0;

    var mouse = new windows.RAWINPUTDEVICE();

    // Flags for removing the mouse device
    mouse.dwFlags =
        windows.API_constants.RIDEV_INPUTSINK |
        windows.API_constants.RIDEV_REMOVE;
    mouse.usUsagePage = 1;
    mouse.usUsage = 2;
    mouse.hwndTarget = 0;

    var devices = Buffer.alloc(windows.RAWINPUTDEVICE.size * 2);
    mouse.ref().copy(devices, 0, 0, windows.RAWINPUTDEVICE.size);
    keyboard.ref().copy(devices, windows.RAWINPUTDEVICE.size, 0, windows.RAWINPUTDEVICE.size);

    windows.user32.RegisterRawInputDevices(devices, 2, windows.RAWINPUTDEVICE.size);

    that.keyboardHookHandle = null;
    that.mouseHookHandle = null;
    windows.metrics.keyboardHookCallback = null;
    windows.metrics.mouseHookCallback = null;
};

/**
 * A value=>name map of only non-printable keys that will be logged.
 */
windows.metrics.specialKeys = fluid.freezeRecursive((function () {
    // A white-list of key values that can be logged. It must not contain printable keys (like letters or numbers).
    // Also, there needs to be a matching value in windows.API_constants.virtualKeyCodes with the VK_ prefix.
    var keys = [
        "BACK", "TAB", "RETURN", "ESCAPE", "PAGEUP", "PAGEDOWN", "END", "HOME", "LEFT", "UP", "RIGHT", "DOWN",
        "SELECT", "PRINT", "EXECUTE", "SNAPSHOT", "INSERT", "DELETE", "HELP", "LWIN", "RWIN", "SCROLL", "NUMLOCK",
        "F1", "F2", "F3", "F4", "F5", "F6", "F7", "F8", "F9", "F10", "F11", "F12", "F13", "F14", "F15", "F16",
        "F17", "F18", "F19", "F20", "F21", "F22", "F23", "F24",
        "CONTROL", "MENU", "SHIFT", "SPACE"
    ];
    var special = {};

    fluid.each(keys, function (keyName) {
        var value = windows.API_constants.virtualKeyCodes["VK_" + keyName];
        if (value) {
            special[value] = keyName;
        }
    });

    return special;
})());

/**
 * Records the timing of a key press. This only logs the time between two keys being pressed, and not the actual
 * value of the key (unless it's a special key). Characters aren't being recorded.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {Number} timestamp Milliseconds since a fixed point in time.
 * @param {String} specialKey The value key, if it's a special key.
 * @param {String} keyValue Character value of the key.
 */
windows.metrics.recordKeyTiming = function (that, timestamp, specialKey, keyValue) {
    var state = that.state.input;
    var config = that.config.input;

    // The time since the last key press
    var keyTime = state.lastKeyTime ? timestamp - state.lastKeyTime : 0;
    if (keyTime > config.sessionTimeout) {
        // Only care about the time between keys in a typing session.
        keyTime = 0;
    } else if (keyTime < 0) {
        // The timestamp is 32bit, and wraps when it gets too big, causing negative times to be recorded [GPII-3877].
        // https://docs.microsoft.com/windows/desktop/api/winuser/nf-winuser-getmessagetime
        keyTime = 0;
    }

    /* "A recordable typing session would be determined only once a threshold of thirty seconds of typing has been
     * reached and ending after a period of not typing for 60 seconds. (the recorded typing time for calculation would
     * include the 30 seconds for threshold and exclude the 60 seconds inactivity session end threshold)"
     */
    if ((state.keyCount > 1) && !keyTime) {
        var duration = state.lastKeyTime - state.sessionStart;
        if (duration > config.minSession && state.keyCount >= config.minSessionKeys) {
            // Record the typing rate for the last typing session.
            var data = {
                duration: duration,
                count: state.keyCount,
                corrections: state.specialCount
            };
            // Keys per minute.
            data.rate = Math.round(60000 / data.duration * data.count);
            that.logMetric("typing-session", data);
        }
        state.keyCount = 0;
    }

    if (!state.keyCount) {
        if (!specialKey) {
            // New typing session.
            state.keyCount = 1;
            state.specialCount = 0;
            state.sessionStart = timestamp;
        }
    } else if (specialKey) {
        state.specialCount++;
    } else {
        state.keyCount++;
    }

    state.lastKeyTime = timestamp;

    var record = {
        keyTime: keyTime
    };

    var modifiers = windows.metrics.getModifierKeys();
    var ctrl = false;
    if (modifiers.length > 0) {
        record.modifierKeys = modifiers;
        ctrl = modifiers.indexOf("CTRL") > -1;
    }

    if (specialKey) {
        // Double-check that only certain keys are being recorded (it would be a serious blunder).
        var keycode = parseInt(fluid.keyForValue(windows.metrics.specialKeys, specialKey));
        if (!!keycode && typeof(specialKey) === "string" && specialKey.length > 1) {
            // Not logging the value of specialKey directly.
            record.key = windows.metrics.specialKeys[keycode];
        }
    }
    if (ctrl) {
        record.key = keyValue;
    }

    that.logMetric("key-time", record);
};

/**
 * Records a mouse event. Movement isn't logged, but the distance is accumulated.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {Number} button Mouse button: 0 movement only, 1 for primary (left), 2 for secondary, W for wheel.
 * @param {Object} pos Mouse cursor coordinates, and wheel distance (if applicable) {x, y, wheel}.
 */
windows.metrics.recordMouseEvent = function (that, button, pos) {
    var state = that.state.input;

    if (state.lastPos) {
        state.distance += Math.sqrt(Math.pow(pos.x, 2) + Math.pow(pos.y, 2));
        // There have been some very large mouse distances captured (billions of pixels). The cause is unknown, so let's
        // just ignore anything that's larger than expected [GPII-3878].
        if (state.distance > 0xffff) {
            //fluid.log("Dropping large mouse distance");
            state.distance = 0;
        }
    }

    state.lastPos = pos;

    // log click or wheel events
    var data;
    if (pos.wheel) {
        data = {wheel: pos.wheel};
    } else if (button) {
        data = {
            button: button,
            distance: Math.round(state.distance)
        };
        // reset the distance accumulator
        state.distance = 0;
    }

    if (data) {
        // Add on the modifier keys.
        var modifiers = windows.metrics.getModifierKeys();
        if (modifiers.length > 0) {
            data.modifierKeys = modifiers;
        }
        that.logMetric("mouse", data);
    }
};

/**
 * Gets the modifier keys that are currently held down.
 * @return {Array<String>} May contain a combination of "CTRL", "ALT", and "SHIFT", identifying which keys are pressed.
 */
windows.metrics.getModifierKeys = function ()
{
    var modifiers = {
        "SHIFT": gpii.windows.API_constants.virtualKeyCodes.VK_SHIFT,
        "CTRL": gpii.windows.API_constants.virtualKeyCodes.VK_CONTROL,
        "ALT": gpii.windows.API_constants.virtualKeyCodes.VK_MENU
    };

    var togo = [];

    fluid.each(modifiers, function (keycode, name) {
        var down = windows.user32.GetKeyState(keycode) & 0x8000;
        if (down) {
            togo.push(name);
        }
    });

    return togo;
};

/**
 * Called by inputHook when it receives some input, then waits for no further input to detect inactivity.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 */
windows.metrics.userInput = function (that) {
    var state = that.state.input;

    if (state.inactive) {
        // First input from being inactive.
        state.inactive = false;
        that.events.onActive.fire();
    }
    if (state.inactivityTimer) {
        clearTimeout(state.inactivityTimer);
        state.inactivityTimer = null;
    }

    state.inactivityTimer = setTimeout(windows.metrics.userInactive, that.config.input.inactiveTime, that,
        that.events.onInactive);
};

/**
 * Called when there's been some time since receiving input from the user.
 *
 * @param {Component} that The gpii.windowsMetrics instance.
 * @param {Event} inactiveEvent [optional] The event to fire.
 */
windows.metrics.userInactive = function (that, inactiveEvent) {
    that.state.input.inactive = true;
    if (inactiveEvent) {
        inactiveEvent.fire();
    }
};
