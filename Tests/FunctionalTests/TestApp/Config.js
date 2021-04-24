var appInsights = require("applicationinsights");

var Config = {
    ServerPort: "9099",
    EndpointBaseAddress: "http://localhost:9091",
    MongoConnectionString: "mongodb://localhost:27017",
    MongoDbName: "testapp",
    MySqlConnectionString: "mysql://root:dummypw@localhost:33060/testdb",
    RedisConnectionString: "redis://localhost:63790",
    MssqlConnectionString: "mssql://sa:yourStrong(!)Password@localhost:14430/master",
    PostgresConnectionString: "pg://postgres:dummypw@localhost:54320/postgres",
    InstrumentationKey: "TESTIKEY",
    AppInsightsEnabled: true,
    UseAutoCorrelation: true,
    UseAutoRequests: true,
    UseAutoPerformance: true,
    UseAutoExceptions: true,
    UseAutoDependencies: true,
    UseAutoConsole: true,
    UseAutoConsoleLog: true,
    UseDiskCaching: false,
    DistributedTracingMode: appInsights.DistributedTracingModes.AI_AND_W3C,
    SampleRate: "100",
}

// Allow config overrides from env variables
for (var prop in Config) {
    var env = process.env["njsperfapp_"+prop];
    if (env) {
        var envLower = env.toLowerCase();
        if (envLower === "true") {
            env = true;
        } else if (envLower === "false") {
            env = false;
        }
        Config[prop] = env || Config[prop];
    }
}

module.exports = Config;
