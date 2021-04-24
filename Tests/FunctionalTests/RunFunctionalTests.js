// Helper script to orchestrate starting Functional Tests
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');
let perfMode = false;

function help() {
    console.log(
        "Usage: node RunFunctionalTests.js [PathToAISDK]\n\n"+
        "PathToAISDK must be an absolute path to a tgz archive"+
        " of the compiled AI SDK,\nor an NPM package reference "+
        "(eg. applicationinsights@0.22.0)\n\nA present AI SDK tgz "+
        "in the root repo directory will be used by default");
    return 0;
}

function findDefaultPath() {
    const rootDir = path.resolve(__dirname, "../../");
    const files = fs.readdirSync(rootDir);
    for(let i = 0; i < files.length; i++) {
        const file = path.join(rootDir, files[i]);
        const stat = fs.lstatSync(file);
        if (!stat.isDirectory()) {
            if (file.indexOf("applicationinsights") === rootDir.length + 1 &&
                file.indexOf(".tgz") === file.length - 4) {
                return path.resolve(file);
            }
        }
    }
    return null;
}

function run(cmd, workingDir) {
    const proc = childProcess.spawnSync(cmd, {
        shell: true,
        cwd: workingDir && path.resolve(__dirname, workingDir)
    });
    return {
        code: proc.status,
        output: proc.output.map(v => String.fromCharCode.apply(null, v)).join("")
    }
}

function runLive(cmd, workingDir) {
    const proc = childProcess.spawnSync(cmd, {
        shell: true,
        cwd: workingDir && path.resolve(__dirname, workingDir),
        stdio: 'inherit'
    });
    return {
        code: proc.status,
        output: proc.output.map(v => String.fromCharCode.apply(null, v)).join("")
    }
}


function runAsync(cmd, workingDir) {
    const proc = childProcess.spawn(cmd, [], {
        shell: true,
        cwd: workingDir && path.resolve(__dirname, workingDir)
    });
    return proc;
}

function startDocker() {
    const tasks =  [
        run("docker run -d -p 27017:27017 --name ainjsmongo mongo"),
        run("docker run -e MYSQL_ROOT_PASSWORD=dummypw -e MYSQL_DATABASE=testdb -d -p 33060:3306 --name ainjsmysql mysql:5"),
        run("docker run -d -p 63790:6379 --name ainjsredis redis:alpine"),
        // run("docker run -e 'ACCEPT_EULA=Y' -e 'SA_PASSWORD=yourStrong(!)Password' -p 14330:1433 -d mcr.microsoft.com/mssql/server:2017-CU8-ubuntu --name ainjsmssql"),
        run("docker run -e POSTGRES_PASSWORD=dummypw -d -p 54320:5432 --name ainjspostgres postgres:alpine")
    ];

    for(let i = 0; i < tasks.length; i++) {
        if (tasks[i].code !== 0) {
            console.error("Failed to start container!");
            console.error(tasks[i].output);
            return false;
        }
    }
    return true;
}

function cleanUpDocker() {
    run("docker stop ainjsmongo");
    run("docker stop ainjsmysql");
    run("docker stop ainjsredis");
    run("docker stop ainjspostgres");
    // run("docker stop ainjsmssql");

    run("docker rm ainjsmongo");
    run("docker rm ainjsmysql");
    run("docker rm ainjsredis");
    run("docker rm ainjspostgres");
    // run("docker rm ainjsmssql");
}

function main() {
    // Find the SDK TGZ archive
    let path = null;
    if (process.argv.length > 2) {
        path = process.argv[2]
        if (path === "-h" || path === "--help") {
            return help();
        }
        if (process.argv.indexOf("-perfmode") !== -1) {
            perfMode = true;
        }
    }
    if (path === null || path.indexOf("-") === 0) {
        path = findDefaultPath();
    }
    if (path === null) {
        console.error("Could not find path for AI SDK!");
        help();
        return 1;
    }
    console.log("Using SDK package at " + path);

    // Validate docker is present on the box
    if (run("docker --version").code !== 0) {
        console.error("Docker not installed!");
        return 1;
    }

    // Prepare docker
    console.log("Spinning up Docker containers...");
    cleanUpDocker(); // Just in case the script failed in a previous run
    if (!startDocker()) {
        console.error("Could not spin up containers!");
        return 1;
    }

    // Prepare runner and testapp
    console.log("Installing Runner and TestApp dependencies...");
    if (run("npm install", "./Runner").code !== 0 || run("npm install", "./TestApp").code !== 0) {
        console.error("Could not install dependencies!");
        return 1;
    }
    console.log("Installing " + path);
    run("npm uninstall applicationinsights", "./TestApp");
    if (run("npm install --no-save " + path, "./TestApp").code !== 0) {
        console.error("Could not install SDK!");
        return 1;
    }

    // Run tests
    console.log("Running functional tests...");
    console.log("=======================\n");
    const testApp = runAsync("node --use_strict Main.js", "./TestApp");
    const runnerStatus = runLive("node --use_strict Main.js" + (perfMode ? " -perfmode": ""), "./Runner").code;
    console.log("\n=======================");

    // Clean up
    console.log("Killing TestApp...");
    testApp.kill();

    console.log("Spinning down and deleting Docker containers...");
    cleanUpDocker();

    return runnerStatus;
}


process.exit(main());
