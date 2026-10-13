// Ashara web client (ADR-076). Plain browser JavaScript, served as-is: no build step.
// Holds no credential: the session lives in an HttpOnly cookie the script cannot read.
// Every message body is rendered with textContent, never as HTML.
"use strict";

(function () {
  const POLL_INTERVAL_MS = 3000;
  const DEFAULT_STOP_REASON = "The client asked to stop this project.";

  const el = (id) => {
    const node = document.getElementById(id);
    if (node === null) throw new Error(`web client: element #${id} is missing from the page`);
    return node;
  };

  const ui = {
    status: el("status"),
    logout: el("logout"),
    login: el("login"),
    loginForm: el("login-form"),
    loginClient: el("login-client"),
    loginCode: el("login-code"),
    workspace: el("workspace"),
    tenderForm: el("tender-form"),
    tenderName: el("tender-name"),
    tenderBody: el("tender-body"),
    projects: el("projects"),
    project: el("project"),
    projectName: el("project-name"),
    projectState: el("project-state"),
    timeline: el("timeline"),
    stopOpen: el("stop-open"),
    stopConfirm: el("stop-confirm"),
    stopReason: el("stop-reason"),
    stopConfirmButton: el("stop-confirm-button"),
    stopCancel: el("stop-cancel"),
  };

  const state = {
    projectId: null,
    rendered: new Map(),
    pollTimer: null,
    // Project id -> status, as the last project listing returned it.
    statuses: new Map(),
    // Whether the selected project's timeline holds a stop the client sent.
    stopSent: false,
  };

  class Unauthorized extends Error {}

  function showStatus(text) {
    ui.status.textContent = text;
  }

  function errorText(data, status) {
    if (data !== null && typeof data === "object" && typeof data.error === "string") return data.error;
    return `request failed with HTTP ${status}`;
  }

  async function api(method, path, body) {
    const headers = {};
    if (method !== "GET") {
      headers["X-Ashara-Client"] = "1";
      headers["Content-Type"] = "application/json";
    }
    const response = await fetch(path, {
      method,
      headers,
      credentials: "same-origin",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (response.status === 401 && path.startsWith("/client/api/")) throw new Unauthorized();
    const text = await response.text();
    let data = null;
    if (text !== "") {
      try {
        data = JSON.parse(text);
      } catch {
        // A proxy or crash page answers in HTML: report the status, not a SyntaxError.
        throw new Error(
          response.ok
            ? `unexpected non-JSON response (HTTP ${response.status})`
            : `request failed with HTTP ${response.status}`,
        );
      }
    }
    if (!response.ok) throw new Error(errorText(data, response.status));
    return data;
  }

  function handleError(err) {
    if (err instanceof Unauthorized) {
      showLogin("Your session has ended. Log in again.");
      return;
    }
    showStatus(err instanceof Error ? err.message : String(err));
  }

  function stopPolling() {
    if (state.pollTimer !== null) clearInterval(state.pollTimer);
    state.pollTimer = null;
  }

  function showLogin(message) {
    stopPolling();
    state.projectId = null;
    ui.workspace.hidden = true;
    ui.logout.hidden = true;
    ui.login.hidden = false;
    showStatus(message);
    if (ui.loginClient.value === "") ui.loginClient.focus();
    else ui.loginCode.focus();
  }

  async function showWorkspace() {
    await loadProjects();
    ui.login.hidden = true;
    ui.workspace.hidden = false;
    ui.logout.hidden = false;
    showStatus("");
  }

  async function loadProjects() {
    const projects = await api("GET", "/client/api/projects");
    state.statuses = new Map(projects.map((project) => [project.id, project.status]));
    ui.projects.replaceChildren();
    for (const project of projects) {
      const item = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.dataset.projectId = project.id;
      button.dataset.status = project.status;
      button.textContent = project.status === "stopped" ? `${project.name} (stopped)` : project.name;
      if (project.id === state.projectId) button.setAttribute("aria-current", "true");
      button.addEventListener("click", () => {
        selectProject(project.id, project.name).catch(handleError);
      });
      item.append(button);
      ui.projects.append(item);
    }
  }

  async function selectProject(projectId, name) {
    stopPolling();
    state.projectId = projectId;
    state.rendered = new Map();
    ui.timeline.replaceChildren();
    ui.projectName.textContent = name;
    state.stopSent = false;
    ui.stopConfirm.hidden = true;
    renderProjectState();
    ui.project.hidden = false;
    for (const button of ui.projects.querySelectorAll("button")) {
      if (button.dataset.projectId === projectId) button.setAttribute("aria-current", "true");
      else button.removeAttribute("aria-current");
    }
    await refreshMessages();
    state.pollTimer = setInterval(() => {
      refreshMessages().catch(handleError);
    }, POLL_INTERVAL_MS);
  }

  // Stop is offered only while the project is neither stopped nor already asked
  // to stop. "Stopped" comes from the server's status, never from the click.
  function renderProjectState() {
    const status = state.statuses.get(state.projectId);
    let text = "";
    if (status === "stopped") {
      text = "Stopped at your request. Ashara does no further work on this project.";
    } else if (state.stopSent) {
      text = "Stop requested. Ashara halts work on this project at its next cycle.";
    }
    ui.projectState.textContent = text;
    ui.projectState.hidden = text === "";
    ui.projectState.dataset.status = status === undefined ? "" : status;
    if (text !== "") ui.stopConfirm.hidden = true;
    ui.stopOpen.hidden = text !== "" || !ui.stopConfirm.hidden;
  }

  function describe(message) {
    if (message.direction === "outbound") {
      return message.kind === "question" ? "Question from Ashara" : "Report from Ashara";
    }
    return `You sent: ${message.kind}`;
  }

  function markAnswered(questionId) {
    const node = state.rendered.get(questionId);
    if (node === undefined) return;
    const form = node.querySelector(".answer");
    if (form === null) return;
    const done = document.createElement("p");
    done.className = "answered";
    done.textContent = "Answered.";
    form.replaceWith(done);
  }

  function answerForm(message) {
    const form = document.createElement("form");
    form.className = "answer";
    const label = document.createElement("label");
    label.textContent = "Your answer";
    label.htmlFor = `answer-${message.id}`;
    const input = document.createElement("textarea");
    input.id = `answer-${message.id}`;
    input.rows = 3;
    input.required = true;
    const send = document.createElement("button");
    send.type = "submit";
    send.textContent = "Send answer";
    form.append(label, input, send);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const projectId = state.projectId;
      send.disabled = true;
      api("POST", `/client/api/projects/${projectId}/messages`, {
        kind: "answer",
        body: input.value,
        inReplyTo: message.id,
      })
        .then(() => refreshMessages())
        .then(() => showStatus(""))
        .catch((err) => {
          send.disabled = false;
          handleError(err);
        });
    });
    return form;
  }

  function renderMessage(message) {
    const item = document.createElement("li");
    item.className = `msg msg-${message.direction} kind-${message.kind}`;
    item.dataset.messageId = message.id;
    item.dataset.kind = message.kind;

    const meta = document.createElement("div");
    meta.className = "msg-meta";
    meta.textContent = `${describe(message)} · ${new Date(message.createdAt).toLocaleString()}`;

    const body = document.createElement("p");
    body.className = "msg-body";
    body.textContent = message.body;

    item.append(meta, body);
    if (message.direction === "outbound" && message.kind === "question") {
      item.append(answerForm(message));
    }
    return item;
  }

  async function refreshMessages() {
    const projectId = state.projectId;
    if (projectId === null) return;
    const messages = await api("GET", `/client/api/projects/${projectId}/messages`);
    // A project switch while the request was in flight makes this answer stale.
    if (projectId !== state.projectId) return;
    for (const message of messages) {
      if (state.rendered.has(message.id)) continue;
      const node = renderMessage(message);
      state.rendered.set(message.id, node);
      ui.timeline.append(node);
    }
    for (const message of messages) {
      if (message.kind === "answer" && message.inReplyTo !== null) markAnswered(message.inReplyTo);
    }
    if (messages.some((message) => message.direction === "inbound" && message.kind === "stop")) {
      state.stopSent = true;
    }
    // A sent stop takes effect when Ashara consumes it; re-read the status until then.
    if (state.stopSent && state.statuses.get(projectId) !== "stopped") {
      await loadProjects();
      if (projectId !== state.projectId) return;
    }
    renderProjectState();
  }

  ui.loginForm.addEventListener("submit", (event) => {
    event.preventDefault();
    api("POST", "/client/login", { client: ui.loginClient.value.trim(), code: ui.loginCode.value })
      .then(() => {
        ui.loginCode.value = "";
        return showWorkspace();
      })
      .catch((err) => showStatus(err instanceof Error ? err.message : String(err)));
  });

  ui.logout.addEventListener("click", () => {
    api("POST", "/client/logout")
      .then(() => showLogin("Logged out."))
      .catch(handleError);
  });

  ui.tenderForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const projectName = ui.tenderName.value;
    api("POST", "/client/api/tenders", { projectName, body: ui.tenderBody.value })
      .then(async (created) => {
        ui.tenderName.value = "";
        ui.tenderBody.value = "";
        await loadProjects();
        await selectProject(created.projectId, projectName);
        showStatus("");
      })
      .catch(handleError);
  });

  ui.stopOpen.addEventListener("click", () => {
    ui.stopOpen.hidden = true;
    ui.stopConfirm.hidden = false;
    ui.stopReason.focus();
  });

  ui.stopCancel.addEventListener("click", () => {
    ui.stopConfirm.hidden = true;
    ui.stopOpen.hidden = false;
  });

  ui.stopConfirmButton.addEventListener("click", () => {
    const reason = ui.stopReason.value.trim();
    api("POST", `/client/api/projects/${state.projectId}/messages`, {
      kind: "stop",
      body: reason === "" ? DEFAULT_STOP_REASON : reason,
    })
      .then(() => {
        ui.stopReason.value = "";
        ui.stopConfirm.hidden = true;
        state.stopSent = true;
        renderProjectState();
        return refreshMessages();
      })
      .catch(handleError);
  });

  showWorkspace().catch((err) => {
    if (err instanceof Unauthorized) showLogin("");
    else handleError(err);
  });
})();
