import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv } from "../types";
import { activity } from "./activity";
import { addresses } from "./addresses";
import { channels } from "./channels";
import { meta } from "./meta";
import { personal } from "./personal";
import { pushToken } from "./pushToken";

export const api = new Hono<AppEnv>();

api.use("*", bodyLimit({ maxSize: 100 * 1024 }));

api.route("/personal", personal);
api.route("/addresses", addresses);
api.route("/channels", channels);
api.route("/push-token", pushToken);
api.route("/activity", activity);
api.route("/", meta);
