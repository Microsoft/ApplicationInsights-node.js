import http = require("http");
import https = require("https");
import url = require("url");
import Contracts = require("../Declarations/Contracts");
import Util = require("../Library/Util");
import RequestResponseHeaders = require("../Library/RequestResponseHeaders");
import RequestParser = require("./RequestParser");
import CorrelationIdManager = require("../Library/CorrelationIdManager");

/**
 * Helper class to read data from the request/response objects and convert them into the telemetry contract
 */
class HttpDependencyParser extends RequestParser {
    private correlationId: string;

    constructor(requestOptions: object | string | http.RequestOptions | https.RequestOptions, request: http.ClientRequest) {
        super();
        if (request && (<any>request).method && requestOptions) {
            // The ClientRequest.method property isn't documented, but is always there.
            this.method = (<any>request).method;

            this.url = HttpDependencyParser._getUrlFromRequestOptions(requestOptions, request);
            this.startTime = +new Date();
        }
    }

    /**
     * Called when the ClientRequest emits an error event.
     */
    public onError(error: Error) {
        this._setStatus(undefined, error);
    }

    /**
     * Called when the ClientRequest emits a response event.
     */
    public onResponse(response: http.ClientResponse) {
        this._setStatus(response.statusCode, undefined);
        this.correlationId = Util.getCorrelationContextTarget(response, RequestResponseHeaders.requestContextTargetKey);
    }

    /**
     * Gets a dependency data contract object for a completed ClientRequest.
     */
    public getDependencyTelemetry(baseTelemetry?: Contracts.Telemetry, dependencyId?: string): Contracts.DependencyTelemetry {
        let urlObject = new url.URL(this.url);
        urlObject.search = undefined;
        urlObject.hash = undefined;
        let dependencyName = this.method.toUpperCase() + " " + urlObject.pathname;


        let remoteDependencyType = Contracts.RemoteDependencyDataConstants.TYPE_HTTP;

        let remoteDependencyTarget = urlObject.hostname;

        if (urlObject.port) {
            remoteDependencyTarget += ":" + urlObject.port;
        }

        if (this.correlationId) {
            remoteDependencyType = Contracts.RemoteDependencyDataConstants.TYPE_AI;
            if (this.correlationId !== CorrelationIdManager.correlationIdPrefix) {
                remoteDependencyTarget += " | " + this.correlationId;
            }
        } else {
            remoteDependencyType = Contracts.RemoteDependencyDataConstants.TYPE_HTTP;
        }

        var dependencyTelemetry: Contracts.DependencyTelemetry & Contracts.Identified = {
            id: dependencyId,
            name: dependencyName,
            data: this.url,
            duration: this.duration,
            success: this._isSuccess(),
            resultCode: this.statusCode ? this.statusCode.toString() : null,
            properties: this.properties || {},
            dependencyTypeName: remoteDependencyType,
            target: remoteDependencyTarget
        };

        if (baseTelemetry && baseTelemetry.time) {
            dependencyTelemetry.time = baseTelemetry.time;
        } else if (this.startTime) {
            dependencyTelemetry.time = new Date(this.startTime);
        }

        // We should keep any parameters the user passed in
        // Except the fields defined above in requestTelemetry, which take priority
        // Except the properties field, where they're merged instead, with baseTelemetry taking priority
        if (baseTelemetry) {
            // Copy missing fields
            for (let key in baseTelemetry) {
                if (!(<any>dependencyTelemetry)[key]) {
                    (<any>dependencyTelemetry)[key] = (<any>baseTelemetry)[key];
                }
            }
            // Merge properties
            if (baseTelemetry.properties) {
                for (let key in baseTelemetry.properties) {
                    dependencyTelemetry.properties[key] = baseTelemetry.properties[key];
                }
            }
        }

        return dependencyTelemetry;
    }

    /**
     * Builds a URL from request options, using the same logic as http.request(). This is
     * necessary because a ClientRequest object does not expose a url property.
     */
    private static _getUrlFromRequestOptions(options: any, request: http.ClientRequest) {
        if (typeof options === 'string') {
            if (options.indexOf("http://") === 0 || options.indexOf("https://") === 0) {
                // protocol exists, parse normally
                options = new url.URL(options);
            } else {
                // protocol not found, insert http/https where appropriate
                const parsed = new url.URL("http://" + options);
                if (parsed.port === "443") {
                    options = new url.URL("https://" + options);
                } else {
                    options = new url.URL("http://" + options);
                }
            }
        } else if (options && typeof url.URL === 'function' && options instanceof URL) {
            return url.format(options);
        } else {
            // Avoid modifying the original options object.
            let originalOptions = options;
            options = {};
            if (originalOptions) {
                Object.keys(originalOptions).forEach(key => {
                    options[key] = originalOptions[key];
                });
            }
        }

        // Oddly, url.format ignores path and only uses pathname and search,
        // so create them from the path, if path was specified
        if (options.path && options.host) {
            // need to force a protocol to make parameter valid - base url is required when input is a relative url
            const parsedQuery = new url.URL(options.path, 'http://' + options.host + options.path);
            options.pathname = parsedQuery.pathname;
            options.search = parsedQuery.search;
        }

        // Similarly, url.format ignores hostname and port if host is specified,
        // even if host doesn't have the port, but http.request does not work
        // this way. It will use the port if one is not specified in host,
        // effectively treating host as hostname, but will use the port specified
        // in host if it exists.
        if (options.host && options.port) {
            // Force a protocol so it will parse the host as the host, not path.
            // It is discarded and not used, so it doesn't matter if it doesn't match
            const parsedHost = new url.URL(`http://${options.host}`);
            if (!parsedHost.port && options.port) {
                options.hostname = options.host;
                delete options.host;
            }
        }

        // Mix in default values used by http.request and others
        options.protocol = options.protocol || ((<any>request).agent && (<any>request).agent.protocol) || ((<any>request).protocol) || undefined;
        options.hostname = options.hostname || 'localhost';

        return url.format(options);
    }
}

export = HttpDependencyParser;
