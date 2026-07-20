import app from "./src/app.js";
import { PORT } from "./src/config.js";
import { disconnectDB } from "./src/database.js";
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
    server.close(async (closeErr) => {
        if (closeErr) {
            logger.error({ err: closeErr }, "Error during shutdown");
            process.exit(1);
            return;
        }
        await disconnectDB();
        process.exit(0);
    });
}

process.on("SIGTERM", () => {
    shutdown("SIGTERM");
});
process.on("SIGINT", () => {
    shutdown("SIGINT");
});
