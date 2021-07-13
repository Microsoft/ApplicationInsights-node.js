import azureCore = require("@azure/core-http");

import CorrelationIdManager = require('./CorrelationIdManager');
import ConnectionStringParser = require('./ConnectionStringParser');
import Logging = require('./Logging');
import Constants = require('../Declarations/Constants');
import http = require('http');
import https = require('https');
import url = require('url');

class Config {
    // Azure adds this prefix to all environment variables
    public static ENV_azurePrefix = "APPSETTING_";

    // This key is provided in the readme
    public static ENV_iKey = "APPINSIGHTS_INSTRUMENTATIONKEY";
    public static legacy_ENV_iKey = "APPINSIGHTS_INSTRUMENTATION_KEY";
    public static ENV_profileQueryEndpoint = "APPINSIGHTS_PROFILE_QUERY_ENDPOINT";
    public static ENV_quickPulseHost = "APPINSIGHTS_QUICKPULSE_HOST";

    // Azure Connection String
    public static ENV_connectionString = "APPLICATIONINSIGHTS_CONNECTION_STRING";

    // Native Metrics Opt Outs
    public static ENV_nativeMetricsDisablers = "APPLICATION_INSIGHTS_DISABLE_EXTENDED_METRIC";
    public static ENV_nativeMetricsDisableAll = "APPLICATION_INSIGHTS_DISABLE_ALL_EXTENDED_METRICS"

    public static ENV_http_proxy = "http_proxy";
    public static ENV_https_proxy = "https_proxy";

    /** An identifier for your Application Insights resource */
    public instrumentationKey: string;
    /** The id for cross-component correlation. READ ONLY. */
    public correlationId: string;
    /** The ingestion endpoint to send telemetry payloads to */
    public endpointUrl: string;
    /** The maximum number of telemetry items to include in a payload to the ingestion endpoint (Default 250) */
    public maxBatchSize: number;
    /** The maximum amount of time to wait for a payload to reach maxBatchSize (Default 15000) */
    public maxBatchIntervalMs: number;
    /** A flag indicating if telemetry transmission is disabled (Default false) */
    public disableAppInsights: boolean;
    /** The percentage of telemetry items tracked that should be transmitted (Default 100) */
    public samplingPercentage: number;
    /** The time to wait before retrying to retrieve the id for cross-component correlation (Default 30000) */
    public correlationIdRetryIntervalMs: number;
    /** A list of domains to exclude from cross-component header injection */
    public correlationHeaderExcludedDomains: string[];
    /** A proxy server for SDK HTTP traffic (Optional, Default pulled from `http_proxy` environment variable) */
    public proxyHttpUrl: string;
    /** A proxy server for SDK HTTPS traffic (Optional, Default pulled from `https_proxy` environment variable) */
    public proxyHttpsUrl: string;
    /** An http.Agent to use for SDK HTTP traffic (Optional, Default undefined) */
    public httpAgent: http.Agent;
    /** An https.Agent to use for SDK HTTPS traffic (Optional, Default undefined) */
    public httpsAgent: https.Agent;

    /** Disable including legacy headers in outgoing requests, x-ms-request-id */
    public ignoreLegacyHeaders?: boolean;

    public isDebugWebSnippet?: boolean;

    private endpointBase: string = Constants.DEFAULT_BREEZE_ENDPOINT;
    private setCorrelationId: (v: string) => void;
    private _profileQueryEndpoint: string;
    /** Host name for quickpulse service */
    private _quickPulseHost: string;


    constructor(setupString?: string) {
        const connectionStringEnv: string | undefined = process.env[Config.ENV_connectionString];
        const csCode = ConnectionStringParser.parse(setupString);
        const csEnv = ConnectionStringParser.parse(connectionStringEnv);
        const iKeyCode = !csCode.instrumentationkey && Object.keys(csCode).length > 0
            ? null // CS was valid but instrumentation key was not provided, null and grab from env var
            : setupString; // CS was invalid, so it must be an ikey

        this.instrumentationKey = csCode.instrumentationkey || iKeyCode /* === instrumentationKey */ || csEnv.instrumentationkey || Config._getInstrumentationKey();
        // validate ikey. If fails throw a warning
        if (!Config._validateInstrumentationKey(this.instrumentationKey)) {
            Logging.warn("An invalid instrumentation key was provided. There may be resulting telemetry loss", this.instrumentationKey);
        }

        this.endpointUrl = `${csCode.ingestionendpoint || csEnv.ingestionendpoint || this.endpointBase}/v2.1/track`;
        this.maxBatchSize = 250;
        this.maxBatchIntervalMs = 15000;
        this.disableAppInsights = false;
        this.samplingPercentage = 100;
        this.correlationIdRetryIntervalMs = 30 * 1000;
        this.correlationHeaderExcludedDomains = [
            "*.core.windows.net",
            "*.core.chinacloudapi.cn",
            "*.core.cloudapi.de",
            "*.core.usgovcloudapi.net",
            "*.core.microsoft.scloud",
            "*.core.eaglex.ic.gov"
        ];

        this.setCorrelationId = (correlationId) => this.correlationId = correlationId;

        this.proxyHttpUrl = process.env[Config.ENV_http_proxy] || undefined;
        this.proxyHttpsUrl = process.env[Config.ENV_https_proxy] || undefined;
        this.httpAgent = undefined;
        this.httpsAgent = undefined;
        this.isDebugWebSnippet = false;
        this.profileQueryEndpoint = csCode.ingestionendpoint || csEnv.ingestionendpoint || process.env[Config.ENV_profileQueryEndpoint] || this.endpointBase;
        this._quickPulseHost = csCode.liveendpoint || csEnv.liveendpoint || process.env[Config.ENV_quickPulseHost] || Constants.DEFAULT_LIVEMETRICS_HOST;
        // Parse quickPulseHost if it starts with http(s)://
        if (this._quickPulseHost.match(/^https?:\/\//)) {
            this._quickPulseHost = url.parse(this._quickPulseHost).host;
        }
    }

    public set profileQueryEndpoint(endpoint: string) {
        CorrelationIdManager.cancelCorrelationIdQuery(this, this.setCorrelationId);
        this._profileQueryEndpoint = endpoint;
        this.correlationId = CorrelationIdManager.correlationIdPrefix; // Reset the correlationId while we wait for the new query
        CorrelationIdManager.queryCorrelationId(this, this.setCorrelationId);
    }

    public get profileQueryEndpoint() {
        return this._profileQueryEndpoint;
    }

    public set quickPulseHost(host: string) {
        this._quickPulseHost = host;
    }

    public get quickPulseHost(): string {
        return this._quickPulseHost;
    }


    private static _getInstrumentationKey(): string {
        // check for both the documented env variable and the azure-prefixed variable
        var iKey = process.env[Config.ENV_iKey]
            || process.env[Config.ENV_azurePrefix + Config.ENV_iKey]
            || process.env[Config.legacy_ENV_iKey]
            || process.env[Config.ENV_azurePrefix + Config.legacy_ENV_iKey];
        if (!iKey || iKey == "") {
            throw new Error("Instrumentation key not found, pass the key in the config to this method or set the key in the environment variable APPINSIGHTS_INSTRUMENTATIONKEY before starting the server");
        }

        return iKey;
    }

    /**
    * Validate UUID Format
    * Specs taken from breeze repo
    * The definition of a VALID instrumentation key is as follows:
    * Not none
    * Not empty
    * Every character is a hex character [0-9a-f]
    * 32 characters are separated into 5 sections via 4 dashes
    * First section has 8 characters
    * Second section has 4 characters
    * Third section has 4 characters
    * Fourth section has 4 characters
    * Fifth section has 12 characters                  
    */
    private static _validateInstrumentationKey(iKey: string): boolean {
        const UUID_Regex = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
        const regexp = new RegExp(UUID_Regex);
        return regexp.test(iKey);
    }
}

export = Config;
