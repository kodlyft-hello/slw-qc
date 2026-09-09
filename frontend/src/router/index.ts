import { createRouter, createWebHashHistory } from "vue-router";

import Checklist from "../pages/Checklist.vue";
import GrnPicker from "../pages/GrnPicker.vue";
import Login from "../pages/Login.vue";
import Queue from "../pages/Queue.vue";

// Hash history, because the packaged app is loaded over file:// where path-based
// routing has no server to fall back on.
export const router = createRouter({
	history: createWebHashHistory(),
	routes: [
		{ path: "/", redirect: "/grns" },
		{ path: "/login", name: "login", component: Login },
		{ path: "/grns", name: "grns", component: GrnPicker },
		{ path: "/checklist/:localName", name: "checklist", component: Checklist, props: true },
		{ path: "/queue", name: "queue", component: Queue },
	],
});

router.beforeEach(async (to) => {
	if (to.name === "login") return true;
	const session = await window.qc.auth.session();
	return session ? true : { name: "login" };
});
