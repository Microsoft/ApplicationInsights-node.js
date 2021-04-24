var Config = require("../Config");
var tds = require("tedious");

var [_, cs] = Config.MssqlConnectionString.split("://");
var [userpass, info] = cs.split("@");
var [name, password] = userpass.split(":");
var [serverport, db] = info.split("/");
var [server, port] = serverport.split(":");

const config = {
    server: server,
    options: {
        port: port,
        database: db
    },
    authentication: {
        type: "default",
        options: {
            userName: name,
            password: password
        }
    }
};

var ready = false;
var conn = null;

function connect() {
    conn = new tds.Connection(config);
    conn.on("connect", (err) => {
        if (err) throw err;
        new tds.Request(`
        CREATE TABLE IF NOT EXISTS test_table (
        id SERIAL,
        data varchar(100) NOT NULL default '',
        PRIMARY KEY  (id)
        );`, () => {
            ready = true;
        });
    });
}
connect();

function query(callback) {
    if (!ready) {
        setTimeout(() => query(callback), 500);
        return;
    }

    new tds.Request(`SELECT * FROM test_table`, (v, x) => {
        callback()
    });
}

module.exports = {
    query: query
}
