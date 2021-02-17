import Util = require("./Util");
import Config = require("./Config");
import {AzureLogger, createClientLogger} from "@azure/logger";

class CorrelationIdManager {
    public static correlationIdPrefix = "cid-v1:";

    public static w3cEnabled = true;

    // To avoid extraneous HTTP requests, we maintain a queue of callbacks waiting on a particular appId lookup,
    // as well as a cache of completed lookups so future requests can be resolved immediately.
    private static pendingLookups: {[key: string]: Function[]} = {};
    private static completedLookups: {[key: string]: string} = {};

    private static requestIdMaxLength = 1024;
    private static currentRootId = Util.randomu32();
    private static _logger = createClientLogger('ApplicationInsights:CorrelationIdManager');

    public static queryCorrelationId(config: Config, callback: (correlationId: string) => void) {
        // GET request to `${this.endpointBase}/api/profiles/${this.instrumentationKey}/appId`
        // If it 404s, the iKey is bad and we should give up
        // If it fails otherwise, try again later
        const appIdUrlString = `${config.profileQueryEndpoint}/api/profiles/${config.instrumentationKey}/appId`;

        if (CorrelationIdManager.completedLookups.hasOwnProperty(appIdUrlString)) {
            callback(CorrelationIdManager.completedLookups[appIdUrlString]);
            return;
        } else if (CorrelationIdManager.pendingLookups[appIdUrlString]) {
            CorrelationIdManager.pendingLookups[appIdUrlString].push(callback);
            return;
        }

        CorrelationIdManager.pendingLookups[appIdUrlString] = [callback];

        const fetchAppId = () => {
            if (!CorrelationIdManager.pendingLookups[appIdUrlString]) {
                // This query has been cancelled.
                return;
            }

            const requestOptions = {
                method: 'GET',
                // Ensure this request is not captured by auto-collection.
                // Note: we don't refer to the property in HttpDependencyParser because that would cause a cyclical dependency
                disableAppInsightsAutoCollection: true
            };

            this._logger.verbose(requestOptions);
            const req = Util.makeRequest(config, appIdUrlString, requestOptions, (res) => {
                if (res.statusCode === 200) {
                    // Success; extract the appId from the body
                    let appId = "";
                    res.setEncoding("utf-8");
                    res.on('data', (data: any) => {
                        appId += data;
                    });
                    res.on('end', () => {
                        this._logger.info(appId)
                        const result = CorrelationIdManager.correlationIdPrefix + appId;
                        CorrelationIdManager.completedLookups[appIdUrlString] = result;
                        if (CorrelationIdManager.pendingLookups[appIdUrlString]) {
                            CorrelationIdManager.pendingLookups[appIdUrlString].forEach((cb) => cb(result));
                        }
                        delete CorrelationIdManager.pendingLookups[appIdUrlString];
                    });
                } else if (res.statusCode >= 400 && res.statusCode < 500) {
                    // Not found, probably a bad key. Do not try again.
                    CorrelationIdManager.completedLookups[appIdUrlString] = undefined;
                    delete CorrelationIdManager.pendingLookups[appIdUrlString];
                } else {
                    // Retry after timeout.
                    setTimeout(fetchAppId, config.correlationIdRetryIntervalMs);
                }
            });
            if (req) {
                req.on('error', (error: Error) => {
                    // Unable to contact endpoint.
                    // Do nothing for now.
                    this._logger.warning(error)
                });
                req.end();
            }
        };
        setTimeout(fetchAppId, 0);
    }

    public static cancelCorrelationIdQuery(config: Config, callback: (correlationId: string) => void) {
        const appIdUrlString = `${config.profileQueryEndpoint}/api/profiles/${config.instrumentationKey}/appId`;
        const pendingLookups = CorrelationIdManager.pendingLookups[appIdUrlString];
        if (pendingLookups) {
            CorrelationIdManager.pendingLookups[appIdUrlString] = pendingLookups.filter((cb) => cb != callback);
            if (CorrelationIdManager.pendingLookups[appIdUrlString].length == 0) {
                delete CorrelationIdManager.pendingLookups[appIdUrlString];
            }
        }
    }

    /**
     * Generate a request Id according to https://github.com/lmolkova/correlation/blob/master/hierarchical_request_id.md
     * @param parentId
     */
    public static generateRequestId(parentId: string): string {
        if (parentId) {
            parentId = parentId[0] == '|' ? parentId : '|' + parentId;
            if (parentId[parentId.length -1] !== '.') {
                parentId += '.';
            }

            const suffix = (CorrelationIdManager.currentRootId++).toString(16);

            return CorrelationIdManager.appendSuffix(parentId, suffix, '_')
        } else {
            return CorrelationIdManager.generateRootId();
        }
    }

    /**
     * Given a hierarchical identifier of the form |X.*
     * return the root identifier X
     * @param id
     */
    public static getRootId(id: string): string {
        let endIndex = id.indexOf('.');
        if (endIndex < 0) {
            endIndex = id.length;
        }

        const startIndex = id[0] === '|' ? 1 : 0;
        return id.substring(startIndex, endIndex);
    }

    private static generateRootId(): string {
        return '|' + Util.w3cTraceId() + '.';
    }

    private static appendSuffix(parentId: string, suffix: string, delimiter: string): string {
        if (parentId.length + suffix.length < CorrelationIdManager.requestIdMaxLength) {
            return parentId + suffix + delimiter;
        }

        // Combined identifier would be too long, so we must truncate it.
        // We need 9 characters of space: 8 for the overflow ID, 1 for the
        // overflow delimiter '#'
        let trimPosition = CorrelationIdManager.requestIdMaxLength - 9;
        if (parentId.length > trimPosition) {
            for(; trimPosition > 1; --trimPosition) {
                const c = parentId[trimPosition-1];
                if (c === '.' || c === '_') {
                    break;
                }
            }
        }

        if (trimPosition <= 1) {
            // parentId is not a valid ID
            return CorrelationIdManager.generateRootId();
        }

        suffix = Util.randomu32().toString(16);
        while (suffix.length < 8) {
            suffix = '0' + suffix;
        }
        return parentId.substring(0,trimPosition) + suffix + '#';
    }
}

export = CorrelationIdManager;
