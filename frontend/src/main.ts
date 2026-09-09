import { createPinia } from "pinia";
import { createApp } from "vue";

import App from "./App.vue";
import { router } from "./router";
import "./styles.css";

const app = createApp(App);

// Used by the sign-in form so the operator can start typing straight away.
app.directive("focus", {
	mounted: (el: HTMLElement) => el.focus(),
});

app.use(createPinia()).use(router).mount("#app");
