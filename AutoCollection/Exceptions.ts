import http = require("http");

import Contracts = require("../Declarations/Contracts");
import Logging = require("../Library/Logging");
import TelemetryClient = require("../Library/TelemetryClient");
import Sender = require("../Library/Sender");
import Queue = require("../Library/Channel");
import Util = require("../Library/Util");

class AutoCollectExceptions {

    public static INSTANCE: AutoCollectExceptions = null;
    public static UNCAUGHT_EXCEPTION_MONITOR_HANDLER_NAME = "uncaughtExceptionMonitor";
    public static UNCAUGHT_EXCEPTION_HANDLER_NAME = "uncaughtException";
    public static UNHANDLED_REJECTION_HANDLER_NAME = "unhandledRejection";

    private static _RETHROW_EXIT_MESSAGE = "Application Insights Rethrow Exception Handler";
    private static _FALLBACK_ERROR_MESSAGE = "A promise was rejected without providing an error. Application Insights generated this error stack for you.";
    private static _canUseUncaughtExceptionMonitor = false;
    private _exceptionListenerHandle: (reThrow: boolean, error: Error) => void;
    private _rejectionListenerHandle: (reThrow: boolean, error: Error) => void;
    private _client: TelemetryClient;
    private _isInitialized: boolean;

    constructor(client: TelemetryClient) {
        if (!!AutoCollectExceptions.INSTANCE) {
            throw new Error("Exception tracking should be configured from the applicationInsights object");
        }

        AutoCollectExceptions.INSTANCE = this;
        this._client = client;

        // Only use for 13.7.0+
        const nodeVer = process.versions.node.split(".");
        AutoCollectExceptions._canUseUncaughtExceptionMonitor = parseInt(nodeVer[0]) > 13 || (parseInt(nodeVer[0]) === 13 && parseInt(nodeVer[1]) >= 7);
    }

    public isInitialized() {
        return this._isInitialized;
    }

    public enable(isEnabled: boolean) {
        if (isEnabled) {
            this._isInitialized = true;
            var self = this;
            if (!this._exceptionListenerHandle) {
                // For scenarios like Promise.reject(), an error won't be passed to the handle. Create a placeholder
                // error for these scenarios.
                var handle = (reThrow: boolean, name: string, error: Error = new Error(AutoCollectExceptions._FALLBACK_ERROR_MESSAGE)) => {
                    this._client.trackException({ exception: error });
                    this._client.flush({ isAppCrashing: true });
                    // only rethrow when we are the only listener
                    if (reThrow && name && process.listeners(name).length === 1) {
                        Logging.error(error);
                        process.exit(1);
                    }
                };

                if (AutoCollectExceptions._canUseUncaughtExceptionMonitor) {
                    // Node.js >= 13.7.0, use uncaughtExceptionMonitor. It handles both promises and exceptions
                    this._exceptionListenerHandle = handle.bind(this, false, undefined); // never rethrows
                    process.on(AutoCollectExceptions.UNCAUGHT_EXCEPTION_MONITOR_HANDLER_NAME, this._exceptionListenerHandle);
                } else {
                    this._exceptionListenerHandle = handle.bind(this, true, AutoCollectExceptions.UNCAUGHT_EXCEPTION_HANDLER_NAME);
                    this._rejectionListenerHandle = handle.bind(this, false, undefined); // never rethrows
                    process.on(AutoCollectExceptions.UNCAUGHT_EXCEPTION_HANDLER_NAME, this._exceptionListenerHandle);
                    process.on(AutoCollectExceptions.UNHANDLED_REJECTION_HANDLER_NAME, this._rejectionListenerHandle);
                }
            }

        } else {
            if (this._exceptionListenerHandle) {
                if (AutoCollectExceptions._canUseUncaughtExceptionMonitor) {
                    process.removeListener(AutoCollectExceptions.UNCAUGHT_EXCEPTION_MONITOR_HANDLER_NAME, this._exceptionListenerHandle);
                } else {
                    process.removeListener(AutoCollectExceptions.UNCAUGHT_EXCEPTION_HANDLER_NAME, this._exceptionListenerHandle);
                    process.removeListener(AutoCollectExceptions.UNHANDLED_REJECTION_HANDLER_NAME, this._rejectionListenerHandle);
                }
                this._exceptionListenerHandle = undefined;
                this._rejectionListenerHandle = undefined;
                delete this._exceptionListenerHandle;
                delete this._rejectionListenerHandle;
            }
        }
    }

    public dispose() {
        AutoCollectExceptions.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
    }
}



export = AutoCollectExceptions;
