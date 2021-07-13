const path = require('path');
const fs = require('fs');
const https = require('https');

let snippetUrl = 'https://raw.githubusercontent.com/microsoft/ApplicationInsights-JS/master/AISKU/snippet/snippet.js';
let snippetMinUrl = 'https://raw.githubusercontent.com/microsoft/ApplicationInsights-JS/master/AISKU/snippet/snippet.min.js';

let snippetPath = path.resolve(__dirname, "snippet.js");
var snippet = fs.createWriteStream(snippetPath);
https.get(snippetUrl, function (res) {
    res.on('data', function (data) {
        snippet.write(data);
    }).on('end', function () {
        snippet.end();
    });
});

let minSnippetPath = path.resolve(__dirname, "snippet.min.js");
var minSnippet = fs.createWriteStream(minSnippetPath);
https.get(snippetMinUrl, function (res) {
    res.on('data', function (data) {
        minSnippet.write(data);
    }).on('end', function () {
        minSnippet.end();
    });
});
