import TelemetryClient= require("../Library/TelemetryClient");
import Logging = require("../Library/Logging");
import Constants = require("../Declarations/Constants");

class AutoCollectNativePerformance {
    public static INSTANCE: AutoCollectNativePerformance;

    private static _emitter: any;
    private static _metricsAvailable: boolean; // is the native metrics lib installed
    private _isEnabled: boolean;
    private _isInitialized: boolean;
    private _handle: NodeJS.Timer;
    private _client: TelemetryClient;

    constructor(client: TelemetryClient) {
        // Note: Only 1 instance of this can exist. So when we reconstruct this object,
        // just disable old native instance and reset JS member variables
        if (AutoCollectNativePerformance.INSTANCE) {
            AutoCollectNativePerformance.INSTANCE.dispose();
        }
        AutoCollectNativePerformance.INSTANCE = this;
        this._client = client;
    }

    /**
     * Start instance of native metrics agent.
     *
     * @param {boolean} isEnabled
     * @param {number} [collectionInterval=60000]
     * @memberof AutoCollectNativePerformance
     */
    public enable(isEnabled: boolean, collectionInterval = 60000): void {
        if (AutoCollectNativePerformance._metricsAvailable == undefined && isEnabled && !this._isInitialized) {
            // Try to require in the native-metrics library. If it's found initialize it, else do nothing and never try again.
            try {
                const NativeMetricsEmitters = require("applicationinsights-native-metrics");
                AutoCollectNativePerformance._emitter = new NativeMetricsEmitters();
                AutoCollectNativePerformance._metricsAvailable = true;
            } catch (err) {
                // Package not available. Never try again
                AutoCollectNativePerformance._metricsAvailable = false;
                return;
            }
        }

        this._isEnabled = isEnabled;
        if (this._isEnabled && !this._isInitialized) {
            this._isInitialized = true;
        }

        // Enable the emitter if we were able to construct one
        if (isEnabled && AutoCollectNativePerformance._emitter) {
            // enable self
            AutoCollectNativePerformance._emitter.enable(true, collectionInterval);
            this._handle = setInterval(this._trackNativeMetrics, collectionInterval);
            this._handle.unref();
        } else if (AutoCollectNativePerformance._emitter) {
            // disable self
            AutoCollectNativePerformance._emitter.enable(false);
            if (this._handle) {
                clearInterval(this._handle);
                this._handle = undefined;
            }
        }
    }

    /**
     * Cleanup this instance of AutoCollectNativePerformance
     *
     * @memberof AutoCollectNativePerformance
     */
    public dispose(): void {
        this.enable(false);
    }

    /**
     * Trigger an iteration of native metrics collection
     *
     * @private
     * @memberof AutoCollectNativePerformance
     */
    private _trackNativeMetrics() {
        this._trackGarbageCollection();
        this._trackEventLoop();
    }

    /**
     * Tracks garbage collection stats for this interval. One custom metric is sent per type of garbage
     * collection that occurred during this collection interval.
     *
     * @private
     * @memberof AutoCollectNativePerformance
     */
    private _trackGarbageCollection(): void {
        const gcData = AutoCollectNativePerformance._emitter.getGCData();

        for (let gc of gcData) {
            const metrics = gc.metrics;
            const name = `${Constants.NativeMetrics.GARBAGE_COLLECTION}: ${gc.type}`;
            this._client.trackMetric({
                name: name,
                value: metrics.total / metrics.count,
                count: metrics.count,
                max: metrics.max,
                min: metrics.min
            });
        }
    }

    /**
     * Tracks event loop ticks per interval as a custom metric. Also included in the metric is min/max/avg
     * time spent in event loop for this interval.
     *
     * @private
     * @returns {void}
     * @memberof AutoCollectNativePerformance
     */
    private _trackEventLoop(): void {
        const loopStats = AutoCollectNativePerformance._emitter.getLoopData();
        if (loopStats.count == 0) {
            return;
        }

        const name = `${Constants.NativeMetrics.EVENT_LOOP}: average tick time (usecs)`
        this._client.trackMetric({
            name: name,
            value: loopStats.total / loopStats.count,
            count: loopStats.count,
            min: loopStats.min,
            max: loopStats.max
        });
    }
}

export = AutoCollectNativePerformance;