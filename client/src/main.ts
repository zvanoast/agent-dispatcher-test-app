import "./styles.css";
import { App } from "./app.js";

const root = document.getElementById("app")!;
const app = new App(root);
app.mount();
