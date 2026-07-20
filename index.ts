import app from "./src/app.js";
import { PORT } from "./src/config.js";
import logger from "./src/utils/logger.js";

const server = app.listen(PORT, () => {
    logger.info({ port: PORT }, "Server started");
});

server.on("error", (err: Error) => {
    logger.error({ err }, "Server failed to start");
    process.exit(1);
});

function shutdown(signal: NodeJS.Signals) {
    logger.info({ signal }, "Shutdown initiated");
    server.close((closeErr) => {
        if (closeErr) {
            logger.error({ err: closeErr }, "Error during shutdown");
            process.exit(1);
        }
        process.exit(0);
    });
}

process.on("SIGTERM", () => {
    shutdown("SIGTERM");
});
process.on("SIGINT", () => {
    shutdown("SIGINT");
});
