import { App } from "./app";
// Imported last so our theme overrides win over Crepe's bundled CSS.
import "./styles.css";

await new App().start();
