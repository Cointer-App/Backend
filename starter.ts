import { connectDb } from "./src/db/client";
import { startServer } from "./src/server";

connectDb();
startServer();
