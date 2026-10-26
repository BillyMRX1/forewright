// Entry point of the web app. Reads the access token from the address bar once and removes it.

import { createRoot } from "react-dom/client";
import { Root } from "./Shell.js";
import { RpcClient, takeToken } from "./rpc.js";
import { readStore } from "./ui.js";

document.documentElement.dataset["theme"] = readStore("forewright.theme") === "light" ? "light" : "dark";

const token = takeToken(window.location, window.history) ?? "";
const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
const rpc = new RpcClient({ url: `${scheme}//${window.location.host}/rpc`, token });

const el = document.getElementById("root");
if (!el) throw new Error("index.html has no #root element.");
createRoot(el).render(<Root rpc={rpc} />);
