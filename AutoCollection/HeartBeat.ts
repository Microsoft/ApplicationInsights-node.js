import os = require("os");
import Vm = require("../Library/AzureVirtualMachine");
import TelemetryClient = require("../Library/TelemetryClient");
import Constants = require("../Declarations/Constants");
import Config = require("../Library/Config");
import Context = require("../Library/Context");

class HeartBeat {

    public static INSTANCE: HeartBeat;

    private _collectionInterval: number = 900000;
    private _client: TelemetryClient;
    private _handle: NodeJS.Timer | null;
    private _isEnabled: boolean;
    private _isInitialized: boolean;

    constructor(client: TelemetryClient) {
        if (!HeartBeat.INSTANCE) {
            HeartBeat.INSTANCE = this;
        }
        this._isInitialized = false;
        this._client = client;
    }

    public enable(isEnabled: boolean, config?: Config) {
        this._isEnabled = isEnabled;
        if (this._isEnabled && !this._isInitialized) {
            this._isInitialized = true;
        }

        if (isEnabled) {
            if (!this._handle) {
                this._handle = setInterval(() => this.trackHeartBeat(config, () => { }), this._collectionInterval);
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

    public static isEnabled() {
        return HeartBeat.INSTANCE && HeartBeat.INSTANCE._isEnabled;
    }

    public trackHeartBeat(config: Config, callback: () => void) {
        let properties: { [key: string]: string } = {};
        const sdkVersion = Context.sdkVersion; // "node" or "node-nativeperf"
        properties["sdk"] = sdkVersion;
        properties["osType"] = os.type();
        if (process.env.WEBSITE_SITE_NAME) { // Web apps
            properties["appSrv_SiteName"] = process.env.WEBSITE_SITE_NAME || "";
            properties["appSrv_wsStamp"] = process.env.WEBSITE_HOME_STAMPNAME || "";
            properties["appSrv_wsHost"] = process.env.WEBSITE_HOSTNAME || "";
        } else if (process.env.FUNCTIONS_WORKER_RUNTIME) { // Function apps
            properties["azfunction_appId"] = process.env.WEBSITE_HOSTNAME;
        } else if (config) {
            let vmInfo = Vm.AzureVirtualMachine.getAzureComputeMetadata(config);
            if (vmInfo.isVM) {
                properties["azInst_vmId"] = vmInfo.id;
                properties["azInst_subscriptionId"] = vmInfo.subscriptionId;
                properties["azInst_osType"] = vmInfo.osType;
            }
        }
        this._client.trackMetric({ name: Constants.HeartBeatMetricName, value: 0, properties: properties });
        callback();
    }

    public dispose() {
        HeartBeat.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
    }
}

export = HeartBeat;
