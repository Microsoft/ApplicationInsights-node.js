import os = require("os");
import EnvelopeFactory = require("../Library/EnvelopeFactory");
import Logging = require("../Library/Logging");
import Sender = require("../Library/Sender");
import Constants = require("../Declarations/Constants");
import Contracts = require("../Declarations/Contracts");
import Vm = require("../Library/AzureVirtualMachine");
import Config = require("../Library/Config");
import Context = require("../Library/Context");

const STATSBEAT_LANGUAGE = "node";
const STATSBEAT_CONNECTIONSTRING = "{STATS BEAT CONNECTION STRING}}";


export class Statsbeat {

    private static TAG = "Statsbeat";

    // Counters
    private _lastRequests: { totalRequestCount: number; time: number; };
    private _totalRequestCount: number = 0;
    private _totalSuccesfulRequestCount: number = 0;
    private _totalFailedRequestCount: number = 0;
    private _retryCount: number = 0;
    private _exceptionCount: number = 0;
    private _throttleCount: number = 0;
    private _intervalRequestExecutionTime: number = 0;
    private _lastIntervalRequestExecutionTime: number = 0;

    private _collectionInterval: number = 900000; // 15 minutes
    private _sender: Sender;
    private _handle: NodeJS.Timer | null;
    private _isEnabled: boolean;
    private _isInitialized: boolean;
    private _config: Config;
    private _statsbeatConfig: Config;

    // Custom dimensions
    private _resourceProvider: string;
    private _sdkVersion: string;
    private _runtimeVersion: string;
    private _os: string;
    private _language: string;
    private _cikey: string;
    private _attach: string = Constants.StatsbeatAttach.sdk; // Default is SDK
    private _features: number = Constants.StatsbeatFeature.NONE;
    private _instrumentations: number = Constants.StatsbeatInstrumentation.NONE;

    constructor(config?: Config) {
        this._isInitialized = false;
        this._config = config;
        this._statsbeatConfig = new Config(STATSBEAT_CONNECTIONSTRING);
        this._sender = new Sender(this._statsbeatConfig);
    }

    public enable(isEnabled: boolean) {
        this._isEnabled = isEnabled;
        if (this._isEnabled && !this._isInitialized) {
            this._getCustomProperties();
            this._isInitialized = true;
        }
        if (isEnabled) {
            if (!this._handle) {
                this._lastRequests = {
                    totalRequestCount: this._totalRequestCount,
                    time: +new Date
                };
                this._handle = setInterval(() => {
                    this.trackStatsbeatMetrics().catch((error) => {
                        // Failed to send Statsbeat
                        Logging.info(Statsbeat.TAG, error);
                    }
                    );
                }, this._collectionInterval);
                this._handle.unref(); // Allow the app to terminate even while this loop is going on
            }
        } else {
            if (this._handle) {
                clearInterval(this._handle);
                this._handle = null;
            }
        }
    }

    public isInitialized() {
        return this._isInitialized;
    }

    public isEnabled() {
        return this._isEnabled;
    }

    public setCodelessAttach() {
        this._attach = Constants.StatsbeatAttach.codeless;
    }

    public addFeature(feature: Constants.StatsbeatFeature) {
        this._features |= feature;
    }

    public removeFeature(feature: Constants.StatsbeatFeature) {
        this._features &= ~feature;
    }

    public addInstrumentation(instrumentation: Constants.StatsbeatInstrumentation) {
        this._instrumentations |= instrumentation;
    }

    public removeInstrumentation(instrumentation: Constants.StatsbeatInstrumentation) {
        this._instrumentations &= ~instrumentation;
    }

    public countRequest(duration: number, success: boolean) {
        if (!this.isEnabled()) {
            return;
        }
        this._totalRequestCount++;
        this._intervalRequestExecutionTime += duration;
        if (success === false) {
            this._totalFailedRequestCount++;
        }
        else {
            this._totalSuccesfulRequestCount++;
        }
    }

    public countException() {
        if (!this.isEnabled()) {
            return;
        }
        this._exceptionCount++;
    }

    public countThrottle() {
        if (!this.isEnabled()) {
            return;
        }
        this._throttleCount++;
    }

    public countRetry() {
        if (!this.isEnabled()) {
            return;
        }
        this._retryCount++;
    }

    public async trackStatsbeatMetrics() {

        this._trackRequestDuration();
        this._trackRequestsCount();
    }

    private async _trackRequestDuration() {
        var lastRequests = this._lastRequests;
        var requests = {
            totalRequestCount: this._totalRequestCount,
            time: +new Date
        };
        var intervalRequests = (requests.totalRequestCount - lastRequests.totalRequestCount) || 0;
        var elapsedMs = requests.time - lastRequests.time;
        var averageRequestExecutionTime = ((this._intervalRequestExecutionTime - this._lastIntervalRequestExecutionTime) / intervalRequests) || 0; // default to 0 in case no requests in this interval
        this._lastIntervalRequestExecutionTime = this._intervalRequestExecutionTime; // reset
        if (elapsedMs > 0 && intervalRequests > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.REQUEST_DURATION, averageRequestExecutionTime);
        }
        this._lastRequests = requests;
    }

    private async _trackRequestsCount() {
        if (this._totalSuccesfulRequestCount > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.REQUEST_SUCCESS, this._totalSuccesfulRequestCount);
            this._totalSuccesfulRequestCount = 0; //Reset
        }
        if (this._totalFailedRequestCount > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.REQUEST_FAILURE, this._totalFailedRequestCount);
            this._totalFailedRequestCount = 0; //Reset
        }
        if (this._retryCount > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.RETRY_COUNT, this._retryCount);
            this._retryCount = 0; //Reset
        }
        if (this._throttleCount > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.THROTTLE_COUNT, this._throttleCount);
            this._throttleCount = 0; //Reset
        }
        if (this._exceptionCount > 0) {
            await this._trackStatsbeat(Constants.StatsbeatCounter.EXCEPTION_COUNT, this._exceptionCount);
            this._exceptionCount = 0; //Reset
        }
    }

    private async _trackStatsbeat(metricName: string, value: number) {
        let statsbeat: Contracts.MetricTelemetry = {
            name: metricName,
            value: value,
            properties: {
                "os": this._os,
                "rp": this._resourceProvider,
                "cikey": this._cikey,
                "runtimeVersion": this._runtimeVersion,
                "language": this._language,
                "version": this._sdkVersion,
                "attach": this._attach,
                "instrumentation": this._instrumentations,
                "feature": this._features,
            }
        };
        let envelope = EnvelopeFactory.createEnvelope(statsbeat, Contracts.TelemetryType.Metric, null, null, this._statsbeatConfig);
        envelope.name = Constants.StatsbeatTelemetryName;
        await this._sender.send([envelope]);
    }

    private _getCustomProperties() {
        this._language = STATSBEAT_LANGUAGE;
        this._cikey = this._config.instrumentationKey;
        this._sdkVersion = Context.sdkVersion; // "node" or "node-nativeperf"
        this._os = os.type();
        this._runtimeVersion = process.version;
        // Check resource provider
        if (process.env.WEBSITE_SITE_NAME) { // Web apps
            this._resourceProvider = Constants.StatsbeatResourceProvider.appsvc;
        } else if (process.env.FUNCTIONS_WORKER_RUNTIME) { // Function apps
            this._resourceProvider = Constants.StatsbeatResourceProvider.function;
        } else if (this._config) {
            let vmInfo = Vm.AzureVirtualMachine.getAzureComputeMetadata(this._config);
            if (vmInfo.isVM) {
                this._resourceProvider = Constants.StatsbeatResourceProvider.vm;
            }
        } else {
            this._resourceProvider = Constants.StatsbeatResourceProvider.unknown;
        }
    }
}

