import TelemetryClient = require("../Library/TelemetryClient");
import Constants = require("../Declarations/Constants");

import { AggregatedMetric } from "../Declarations/Metrics/AggregatedMetric";
import { AggregatedMetricCounter } from "../Declarations/Metrics/AggregatedMetricCounters";
import {
    MetricBaseDimensions,
    MetricDependencyDimensions,
    MetricExceptionDimensions,
    MetricRequestDimensions,
    MetricTraceDimensions,
    PreaggregatedMetricPropertyNames,
    MetricDimensionTypeKeys
} from "../Declarations/Metrics/AggregatedMetricDimensions";
import * as Contracts from "../Declarations/Contracts";


class AutoCollectPreAggregatedMetrics {

    public static INSTANCE: AutoCollectPreAggregatedMetrics;
    private _collectionInterval: number;
    private _client: TelemetryClient;
    private _handle: NodeJS.Timer;
    private _isEnabled: boolean;
    private _isInitialized: boolean;

    private static _dependencyCountersCollection: Array<AggregatedMetricCounter>;
    private static _requestCountersCollection: Array<AggregatedMetricCounter>;
    private static _exceptionCountersCollection: Array<AggregatedMetricCounter>;
    private static _traceCountersCollection: Array<AggregatedMetricCounter>;

    /**
     * @param client - Telemetry Client
     * @param collectionInterval - Metric collection interval in ms
     */
    constructor(client: TelemetryClient, collectionInterval = 60000) {
        if (!AutoCollectPreAggregatedMetrics.INSTANCE) {
            AutoCollectPreAggregatedMetrics.INSTANCE = this;
        }

        this._isInitialized = false;
        AutoCollectPreAggregatedMetrics._dependencyCountersCollection = [];
        AutoCollectPreAggregatedMetrics._requestCountersCollection = [];
        AutoCollectPreAggregatedMetrics._exceptionCountersCollection = [];
        AutoCollectPreAggregatedMetrics._traceCountersCollection = [];
        this._client = client;
        this._collectionInterval = collectionInterval;
    }

    public enable(isEnabled: boolean, collectionInterval?: number) {
        this._isEnabled = isEnabled;
        if (this._isEnabled && !this._isInitialized) {
            this._isInitialized = true;
        }

        if (isEnabled) {
            if (!this._handle) {
                this._collectionInterval = collectionInterval || this._collectionInterval;
                this._handle = setInterval(() => this.trackPreAggregatedMetrics(), this._collectionInterval);
                this._handle.unref(); // Allow the app to terminate even while this loop is going on
            }
        } else {
            if (this._handle) {
                clearInterval(this._handle);
                this._handle = undefined;
            }
        }
    }

    public static countException(dimensions: MetricExceptionDimensions) {
        if (!AutoCollectPreAggregatedMetrics.isEnabled()) {
            return;
        }
        let counter: AggregatedMetricCounter = AutoCollectPreAggregatedMetrics._getAggregatedCounter(dimensions, this._exceptionCountersCollection);
        counter.totalCount++;
    }

    public static countTrace(dimensions: MetricTraceDimensions) {
        if (!AutoCollectPreAggregatedMetrics.isEnabled()) {
            return;
        }
        let counter: AggregatedMetricCounter = AutoCollectPreAggregatedMetrics._getAggregatedCounter(dimensions, this._traceCountersCollection);
        counter.totalCount++;
    }

    public static countRequest(duration: number | string, dimensions: MetricRequestDimensions) {
        if (!AutoCollectPreAggregatedMetrics.isEnabled()) {
            return;
        }
        let durationMs: number;
        let counter: AggregatedMetricCounter = AutoCollectPreAggregatedMetrics._getAggregatedCounter(dimensions, this._requestCountersCollection);
        if (typeof duration === 'string') {
            // dependency duration is passed in as "00:00:00.123" by autocollectors
            durationMs = +new Date('1970-01-01T' + duration + 'Z'); // convert to num ms, returns NaN if wrong
        } else if (typeof duration === 'number') {
            durationMs = duration;
        } else {
            return;
        }
        counter.intervalExecutionTime += durationMs;
        counter.totalCount++;
    }

    public static countDependency(duration: number | string, dimensions: MetricDependencyDimensions) {
        if (!AutoCollectPreAggregatedMetrics.isEnabled()) {
            return;
        }
        let counter: AggregatedMetricCounter = AutoCollectPreAggregatedMetrics._getAggregatedCounter(dimensions, this._dependencyCountersCollection);
        let durationMs: number;
        if (typeof duration === 'string') {
            // dependency duration is passed in as "00:00:00.123" by autocollectors
            durationMs = +new Date('1970-01-01T' + duration + 'Z'); // convert to num ms, returns NaN if wrong
        } else if (typeof duration === 'number') {
            durationMs = duration;
        } else {
            return;
        }
        counter.intervalExecutionTime += durationMs;
        counter.totalCount++;
    }

    public isInitialized() {
        return this._isInitialized;
    }

    public static isEnabled() {
        return AutoCollectPreAggregatedMetrics.INSTANCE && AutoCollectPreAggregatedMetrics.INSTANCE._isEnabled;
    }

    public trackPreAggregatedMetrics() {
        this._trackRequestMetrics();
        this._trackDependencyMetrics();
        this._trackExceptionMetrics();
        this._trackTraceMetrics();
    }

    private static _getAggregatedCounter(dimensions: MetricBaseDimensions, counterCollection: Array<AggregatedMetricCounter>): AggregatedMetricCounter {
        let notMatch = false;
        // Check if counter with specified dimensions is available
        for (let i = 0; i < counterCollection.length; i++) {
            // Same object
            if (dimensions === counterCollection[i].dimensions) {
                return counterCollection[i];
            }
            // Diferent number of keys skip
            if (Object.keys(dimensions).length !== Object.keys(counterCollection[i].dimensions).length) {
                continue;
            }
            // Check dimension values
            for (let dim in dimensions) {
                if ((<any>dimensions)[dim] != (<any>counterCollection[i].dimensions)[dim]) {
                    notMatch = true;
                    break;
                }
            }
            if (!notMatch) { // Found
                return counterCollection[i];
            }
            notMatch = false;
        }
        // Create a new one if not found
        let newCounter = new AggregatedMetricCounter(dimensions);
        counterCollection.push(newCounter);
        return newCounter;
    }

    private _trackRequestMetrics() {
        for (let i = 0; i < AutoCollectPreAggregatedMetrics._requestCountersCollection.length; i++) {
            var currentCounter = AutoCollectPreAggregatedMetrics._requestCountersCollection[i];
            currentCounter.time = +new Date;
            var intervalRequests = (currentCounter.totalCount - currentCounter.lastTotalCount) || 0;
            var elapsedMs = currentCounter.time - currentCounter.lastTime;
            var averageRequestExecutionTime = ((currentCounter.intervalExecutionTime - currentCounter.lastIntervalExecutionTime) / intervalRequests) || 0;
            currentCounter.lastIntervalExecutionTime = currentCounter.intervalExecutionTime; // reset
            if (elapsedMs > 0) {
                if (intervalRequests > 0) {
                    this._trackPreAggregatedMetric({
                        name: "Server response time",
                        dimensions: currentCounter.dimensions,
                        value: averageRequestExecutionTime,
                        count: intervalRequests,
                        aggregationInterval: elapsedMs,
                        metricType: Constants.MetricId.REQUESTS_DURATION,
                    });
                }
            }
            // Set last counters
            currentCounter.lastTotalCount = currentCounter.totalCount;
            currentCounter.lastTime = currentCounter.time;
        }
    }

    private _trackDependencyMetrics() {
        for (let i = 0; i < AutoCollectPreAggregatedMetrics._dependencyCountersCollection.length; i++) {
            var currentCounter = AutoCollectPreAggregatedMetrics._dependencyCountersCollection[i];
            currentCounter.time = +new Date;
            var intervalDependencies = (currentCounter.totalCount - currentCounter.lastTotalCount) || 0;
            var elapsedMs = currentCounter.time - currentCounter.lastTime;
            var averageDependencyExecutionTime = ((currentCounter.intervalExecutionTime - currentCounter.lastIntervalExecutionTime) / intervalDependencies) || 0;
            currentCounter.lastIntervalExecutionTime = currentCounter.intervalExecutionTime; // reset
            if (elapsedMs > 0) {
                if (intervalDependencies > 0) {
                    this._trackPreAggregatedMetric({
                        name: "Dependency duration",
                        dimensions: currentCounter.dimensions,
                        value: averageDependencyExecutionTime,
                        count: intervalDependencies,
                        aggregationInterval: elapsedMs,
                        metricType: Constants.MetricId.DEPENDENCIES_DURATION,
                    });
                }
            }
            // Set last counters
            currentCounter.lastTotalCount = currentCounter.totalCount;
            currentCounter.lastTime = currentCounter.time;
        }
    }

    private _trackExceptionMetrics() {
        for (let i = 0; i < AutoCollectPreAggregatedMetrics._exceptionCountersCollection.length; i++) {
            var currentCounter = AutoCollectPreAggregatedMetrics._exceptionCountersCollection[i];
            var intervalExceptions = (currentCounter.totalCount - currentCounter.lastTotalCount) || 0;
            var elapsedMs = currentCounter.time - currentCounter.lastTime;
            this._trackPreAggregatedMetric({
                name: "Exceptions",
                dimensions: currentCounter.dimensions,
                value: intervalExceptions,
                count: intervalExceptions,
                aggregationInterval: elapsedMs,
                metricType: Constants.MetricId.EXCEPTIONS_COUNT,
            });

            // Set last counters
            currentCounter.lastTotalCount = currentCounter.totalCount;
            currentCounter.lastTime = currentCounter.time;
        }
    }

    private _trackTraceMetrics() {
        for (let i = 0; i < AutoCollectPreAggregatedMetrics._traceCountersCollection.length; i++) {
            var currentCounter = AutoCollectPreAggregatedMetrics._traceCountersCollection[i];
            var intervalTraces = (currentCounter.totalCount - currentCounter.lastTotalCount) || 0;
            var elapsedMs = currentCounter.time - currentCounter.lastTime;
            this._trackPreAggregatedMetric({
                name: "Traces",
                dimensions: currentCounter.dimensions,
                value: intervalTraces,
                count: intervalTraces,
                aggregationInterval: elapsedMs,
                metricType: Constants.MetricId.TRACES_COUNT,
            });

            // Set last counters
            currentCounter.lastTotalCount = currentCounter.totalCount;
            currentCounter.lastTime = currentCounter.time;
        }
    }

    private _trackPreAggregatedMetric(metric: AggregatedMetric) {
        // Build metric properties
        let metricProperties: any = {};
        for (let dim in metric.dimensions) {
            metricProperties[PreaggregatedMetricPropertyNames[dim as MetricDimensionTypeKeys]] = metric.dimensions[dim];
        }
        metricProperties = {
            ...metricProperties,
            "_MS.MetricId": metric.metricType,
            "_MS.AggregationIntervalMs": String(metric.aggregationInterval),
            "_MS.IsAutocollected": "True",
        };

        let telemetry: Contracts.MetricTelemetry = {
            name: metric.name,
            value: metric.value,
            count: metric.count,
            properties: metricProperties,
            kind: "Aggregation",
        };
        this._client.trackMetric(telemetry);
    }

    public dispose() {
        AutoCollectPreAggregatedMetrics.INSTANCE = null;
        this.enable(false);
        this._isInitialized = false;
    }
}

export = AutoCollectPreAggregatedMetrics;
