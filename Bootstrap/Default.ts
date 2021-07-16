import * as types from "../applicationinsights";
import * as Helpers from "./Helpers";
import * as DataModel from "./DataModel";
import Constants = require("../Declarations/Constants");
import { StatusLogger, StatusContract } from "./StatusLogger";
import { DiagnosticLogger } from "./DiagnosticLogger";

// Private configuration vars
let _appInsights: typeof types | null;
let _prefix = "ad_"; // App Services, Default
let _logger: DiagnosticLogger = new DiagnosticLogger(console);
let _statusLogger: StatusLogger = new StatusLogger(console);

// Env var local constants
const _setupString = process.env.APPLICATIONINSIGHTS_CONNECTION_STRING || process.env.APPINSIGHTS_INSTRUMENTATIONKEY;
const forceStart = process.env.APPLICATIONINSIGHTS_FORCE_START === "true";

// Other local constants
const defaultStatus: StatusContract = {
    ...StatusLogger.DEFAULT_STATUS,
    Ikey: _setupString,
};

/**
 * Sets the attach-time logger
 * @param logger logger which implements the `AgentLogger` interface
 */
export function setLogger(logger: DiagnosticLogger) {
    return _logger = logger;
}

/**
 * Sets the string which is prefixed to the existing sdkVersion, e.g. `ad_`, `alr_`
 * @param prefix string prefix, including underscore. Defaults to `ad_`
 */
export function setUsagePrefix(prefix: string) {
    _prefix = prefix;
}

export function setStatusLogger(statusLogger: StatusLogger) {
    _statusLogger = statusLogger;
}

/**
 * Try to setup and start this app insights instance if attach is enabled.
 * @param setupString connection string or instrumentation key
 */
export function setupAndStart(setupString = _setupString): typeof types | null {
    // If app already contains SDK, skip agent attach
    if (!forceStart && Helpers.sdkAlreadyExists(_logger)) {
        _statusLogger.logStatus({
            ...defaultStatus,
            AgentInitializedSuccessfully: false,
            SDKPresent: true,
            Reason: "SDK already exists"
        })
        return null;
    }

    if (!setupString) {
        const message = "Application Insights wanted to be started, but no Connection String or Instrumentation Key was provided";
        _logger.logError(message);
        _statusLogger.logStatus({
            ...defaultStatus,
            AgentInitializedSuccessfully: false,
            Reason: message,
        });
        return null;
    }

    try {
        _appInsights = require("../applicationinsights");
        if (_appInsights.defaultClient) {
            // setupAndStart was already called, return the result
            _logger.logError("Setup was attempted on the Application Insights Client multiple times. Aborting and returning the first client instance");
            return _appInsights;
        }

        const prefixInternalSdkVersion = function (envelope: types.Contracts.Envelope, _contextObjects: Object) {
            try {
                var appInsightsSDKVersion = _appInsights.defaultClient.context.keys.internalSdkVersion;
                envelope.tags[appInsightsSDKVersion] = _prefix + envelope.tags[appInsightsSDKVersion];
            } catch (e) {
                _logger.logError("Error prefixing SDK version", e);
            }
            return true;
        }

        const copyOverPrefixInternalSdkVersionToHeartBeatMetric = function (envelope: types.Contracts.Envelope, _contextObjects: Object) {
            var appInsightsSDKVersion = _appInsights.defaultClient.context.keys.internalSdkVersion;
            const sdkVersion = envelope.tags[appInsightsSDKVersion] || "";
            if (envelope.name === Constants.HeartBeatMetricName) {
                ((envelope.data as any).baseData).properties = ((envelope.data as any).baseData).properties || {};
                ((envelope.data as any).baseData).properties["sdk"] = sdkVersion;
            }

            return true;
        }

        // Instrument the SDK
        _appInsights.setup(setupString).setSendLiveMetrics(true);
        _appInsights.defaultClient.setAutoPopulateAzureProperties(true);
        _appInsights.defaultClient.addTelemetryProcessor(prefixInternalSdkVersion);
        _appInsights.defaultClient.addTelemetryProcessor(copyOverPrefixInternalSdkVersionToHeartBeatMetric);
        _appInsights.start();
        // Add attach flag in Statsbeat
        let statsbeat = _appInsights.defaultClient.getStatsbeat();
        if (statsbeat) {
            statsbeat.setCodelessAttach();
        }

        // Agent successfully instrumented the SDK
        _logger.logMessage("Application Insights was started with setupString: " + setupString);
        _statusLogger.logStatus({
            ...defaultStatus,
            AgentInitializedSuccessfully: true
        });
    } catch (e) {
        _logger.logError("Error setting up Application Insights", e);
        _statusLogger.logStatus({
            ...defaultStatus,
            AgentInitializedSuccessfully: false,
            Reason: `Error setting up Application Insights: ${e && e.message}`
        })
    }
    return _appInsights;
}
