import http = require("http");
import assert = require("assert");
import sinon = require("sinon");

import HttpDependencyParser = require("../../AutoCollection/HttpDependencyParser");
import Contracts = require("../../Declarations/Contracts");

describe("AutoCollection/HttpDependencyParser", () => {

    describe("#getDependencyData()", () => {
        let request: http.ClientRequest = <any>{
            agent: { protocol: "http" },
        };
        let response: http.ClientResponse = <any>{
        };

        it("should return correct data for a URL string", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com/search", request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /search");
            assert.equal(dependencyTelemetry.data, "http://bing.com/search");
            assert.equal(dependencyTelemetry.target, "bing.com");
        });

        it("should return correct data for a URL string with correlationId", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com:123/search", request);

            response.statusCode = 200;
            parser.onResponse(response);

            parser["correlationId"] = "abcdefg";
            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_AI);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /search");
            assert.equal(dependencyTelemetry.data, "http://bing.com:123/search");
            assert.equal(dependencyTelemetry.target, "bing.com:123 | abcdefg");
        });

        it("should return correct data for a URL without a protocol (https)", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("a.bing.com:443/search", request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /search");
            assert.equal(dependencyTelemetry.data, "https://a.bing.com/search");
            assert.equal(dependencyTelemetry.target, "a.bing.com");
        });

        it("should return correct data for a URL without a protocol (http)", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("a.bing.com:123/search", request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /search");
            assert.equal(dependencyTelemetry.data, "http://a.bing.com:123/search");
            assert.equal(dependencyTelemetry.target, "a.bing.com:123");
        });

        if (parseInt(process.versions.node.split(".")[0]) >= 10) {
            it("should return correct data for a URL instance", () => {
                (<any>request)["method"] = "GET";
                let parser = new HttpDependencyParser(new URL("http://bing.com/search"), request);

                response.statusCode = 200;
                parser.onResponse(response);

                let dependencyTelemetry = parser.getDependencyTelemetry();
                assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
                assert.equal(dependencyTelemetry.success, true);
                assert.equal(dependencyTelemetry.name, "GET /search");
                assert.equal(dependencyTelemetry.data, "http://bing.com/search");
                assert.equal(dependencyTelemetry.target, "bing.com");
            });
        }

        it("should propagate a custom timestamp", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com/search", request);

            response.statusCode = 200;
            parser.onResponse(response);

            const dependencyTelemetry1 = parser.getDependencyTelemetry({ time: new Date(111111) });
            const dependencyTelemetry2 = parser.getDependencyTelemetry({ time: new Date(222222) });
            assert.deepEqual(dependencyTelemetry1.time, new Date(111111));
            assert.deepEqual(dependencyTelemetry2.time, new Date(222222));
            assert.notDeepEqual(dependencyTelemetry1, dependencyTelemetry2);
        });

        it("should return correct data for a posted URL with query string", () => {
            (<any>request)["method"] = "POST";
            let parser = new HttpDependencyParser("http://bing.com/search?q=test", request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "POST /search");
            assert.equal(dependencyTelemetry.data, "http://bing.com/search?q=test");
            assert.equal(dependencyTelemetry.target, "bing.com");
        });

        it("should return correct data for a request options object", () => {
            let requestOptions = {
                host: "bing.com",
                port: 8000,
                path: "/search?q=test",
            };
            (<any>request)["method"] = "POST";
            let parser = new HttpDependencyParser(requestOptions, request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "POST /search");
            assert.equal(dependencyTelemetry.data, "http://bing.com:8000/search?q=test");
            assert.equal(dependencyTelemetry.target, "bing.com:8000");
        });

        it("should return correct data for URL with protocol in request", () => {
            let testRequest: http.ClientRequest = <any>{
                agent: { protocol: undefined },
                method: "GET",
                protocol: "https:"
            };
            let requestOptions = {
                host: "bing.com",
                port: 8000,
                path: "/search?q=test",
            };

            let parser = new HttpDependencyParser(requestOptions, testRequest);
            response.statusCode = 200;
            parser.onResponse(response);
            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /search");
            assert.equal(dependencyTelemetry.data, "https://bing.com:8000/search?q=test");
            assert.equal(dependencyTelemetry.target, "bing.com:8000");
        });

        it("should return correct data for a request options object", () => {
            var path = "/finance/info?client=ig&q=";

            let requestOptions = {
                host: "finance.google.com",
                path: path + "msft"
            };
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser(requestOptions, request);

            response.statusCode = 200;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, true);
            assert.equal(dependencyTelemetry.name, "GET /finance/info");
            assert.equal(dependencyTelemetry.data, "http://finance.google.com/finance/info?client=ig&q=msft");
            assert.equal(dependencyTelemetry.target, "finance.google.com");
        });

        it("should return non-success for a request error", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com/search", request);
            parser.onError(new Error("test error message"));

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, false);
            assert.ok(dependencyTelemetry.properties);
            assert.equal(dependencyTelemetry.properties.error, "test error message");
        });

        it("should return non-success for a response error status", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com/search", request);

            response.statusCode = 400;
            parser.onResponse(response);

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, false);
        });

        it("should return non-success for a request abort", () => {
            (<any>request)["method"] = "GET";
            let parser = new HttpDependencyParser("http://bing.com/search", request);
            parser.onError(new Error());

            let dependencyTelemetry = parser.getDependencyTelemetry();
            assert.equal(dependencyTelemetry.dependencyTypeName, Contracts.RemoteDependencyDataConstants.TYPE_HTTP);
            assert.equal(dependencyTelemetry.success, false);
            assert.ok(dependencyTelemetry.properties);
        });
    });
});
