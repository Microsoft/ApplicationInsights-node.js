import http = require("http");
import https = require("https");
import url = require("url");

import Contracts = require("../Declarations/Contracts");
import Client = require("../Library/Client");
import Logging = require("../Library/Logging");
import Util = require("../Library/Util");
import RequestParser = require("./RequestParser");

/**
 * Helper class to read data from the requst/response objects and convert them into the telemetry contract
 */
class ClientRequestParser extends RequestParser {
    private correlationId: string;

    constructor(requestOptions: string | http.RequestOptions | https.RequestOptions, request: http.ClientRequest) {
        super();
        if (request && (<any>request).method && requestOptions) {
            // The ClientRequest.method property isn't documented, but is always there.
            this.method = (<any>request).method;

            this.url = ClientRequestParser._getUrlFromRequestOptions(requestOptions, request);
            this.startTime = +new Date();
        }
    }

    /**
     * Called when the ClientRequest emits an error event.
     */
    public onError(error: Error, properties?: { [key: string]: string }) {
        this._setStatus(undefined, error, properties);
    }

    /**
     * Called when the ClientRequest emits a response event.
     */
    public onResponse(response: http.ClientResponse, properties?: { [key: string]: string }) {
        this._setStatus(response.statusCode, undefined, properties);
        this.correlationId = Util.getCorrelationContextTarget(response);
    }

    /**
     * Gets a dependency data contract object for a completed ClientRequest.
     */
    public getDependencyData(): Contracts.Data<Contracts.RemoteDependencyData> {
        let urlObject = url.parse(this.url);
        urlObject.search = undefined;
        urlObject.hash = undefined;
        let dependencyName = this.method.toUpperCase() + " " + urlObject.pathname;

        let remoteDependency = new Contracts.RemoteDependencyData();
        remoteDependency.type = Contracts.RemoteDependencyDataConstants.TYPE_HTTP;

        if (this.correlationId) {
            remoteDependency.type = Contracts.RemoteDependencyDataConstants.TYPE_AI;
            remoteDependency.target = urlObject.hostname + " | " + this.correlationId;
        } else {
            remoteDependency.type = Contracts.RemoteDependencyDataConstants.TYPE_HTTP;
            remoteDependency.target = urlObject.hostname;
        }

        remoteDependency.name = dependencyName;
        remoteDependency.data = this.url;
        remoteDependency.duration = Util.msToTimeSpan(this.duration);
        remoteDependency.success = this._isSuccess();
        remoteDependency.resultCode = this.statusCode ? this.statusCode.toString() : null;
        remoteDependency.properties = this.properties || {};

        let data = new Contracts.Data<Contracts.RemoteDependencyData>();
        data.baseType = "Microsoft.ApplicationInsights.RemoteDependencyData";
        data.baseData = remoteDependency;

        return data;
    }

    /**
     * Builds a URL from request options, using the same logic as http.request(). This is
     * necessary because a ClientRequest object does not expose a url property.
     */
    private static _getUrlFromRequestOptions(options: any, request: http.ClientRequest) {
        if (typeof options === 'string') {
            options = url.parse(options);
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
        if (options.path) {
            const parsedQuery = url.parse(options.path);
            options.pathname = parsedQuery.pathname;
            options.search = parsedQuery.search;
        }

        // Simiarly, url.format ignores hostname and port if host is specified,
        // even if host doesn't have the port, but http.request does not work
        // this way. It will use the port if one is not specified in host,
        // effectively treating host as hostname, but will use the port specified
        // in host if it exists.
        if (options.host && options.port) {
            // Force a protocol so it will parse the host as the host, not path.
            // It is discarded and not used, so it doesn't matter if it doesn't match
            const parsedHost = url.parse(`http://${options.host}`);
            if (!parsedHost.port && options.port) {
                options.hostname = options.host;
                delete options.host;
            }
        }

        // Mix in default values used by http.request and others
        options.protocol = options.protocol || (<any>request).agent.protocol;
        options.hostname = options.hostname || 'localhost';

        return url.format(options);
    }
}

export = ClientRequestParser;
