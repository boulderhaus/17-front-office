(() => {
  // Show/Hide on every password field (here, not inline, to keep the strict CSP). Hidden again on submit.
  document.querySelectorAll(".publicform .pwfield input").forEach((input) => {
    if (!input.id) return;
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "pwtoggle";
    toggle.setAttribute("aria-controls", input.id);
    const word = document.createTextNode("Show");
    // The hidden words name the field, so "New password" and "Type it again" don't both read "Show password".
    const label = (input.labels?.[0]?.textContent ?? "").trim().toLowerCase();
    const rest = document.createElement("span");
    rest.className = "vh";
    rest.textContent = ` ${!label || label === "password" ? "password" : label.includes("password") ? label : `password (${label})`}`;
    toggle.append(word, rest);
    const set = (shown) => {
      input.type = shown ? "text" : "password";
      word.textContent = shown ? "Hide" : "Show";
    };
    toggle.addEventListener("click", () => set(input.type === "password"));
    input.form?.addEventListener("submit", () => set(false));
    input.after(toggle);
  });

  // One tap sends a form once: the button says "Sending…" and later taps do nothing while it's on its way.
  // Ready again only after Back. No timer: a slow sign-up or booking must never let a second tap charge or book twice.
  const labels = new WeakMap();
  const ready = (formElement) => {
    delete formElement.dataset.busy;
    formElement.querySelectorAll('[aria-busy="true"]').forEach((button) => {
      button.removeAttribute("aria-busy");
      if (labels.has(button)) button.replaceChildren(...labels.get(button));
    });
  };
  document.querySelectorAll("form.publicform, .publicform form").forEach((formElement) => {
    formElement.addEventListener("submit", (event) => {
      if (formElement.dataset.busy) {
        event.preventDefault();
        return;
      }
      const button = event.submitter ?? formElement.querySelector('button:not([type="button"])');
      if (!button) return;
      formElement.dataset.busy = "1";
      // Not disabled: a disabled submitter drops its name and value (the booking time) from the post.
      button.setAttribute("aria-busy", "true");
      labels.set(button, [...button.childNodes]);
      button.replaceChildren("Sending…");
    });
  });
  window.addEventListener("pageshow", () => document.querySelectorAll("form[data-busy]").forEach(ready));

  // Signup: send the browser's timezone so the shop's hours start out right.
  const timezone = document.querySelector('.publicform input[name="timezone"]');
  if (timezone && !timezone.value) {
    try { timezone.value = Intl.DateTimeFormat().resolvedOptions().timeZone || ""; } catch { /* the server falls back to the state's zone */ }
  }
  const form = document.querySelector(".publicform");
  const steps = form?.querySelectorAll("fieldset");
  if (!form || !steps || steps.length < 2) return;

  form.classList.add("is-enhanced");
  const progress = document.createElement("div");
  progress.className = "wizard-progress";
  progress.innerHTML = "<span></span><i><b></b></i>";
  form.before(progress);

  const show = (index) => {
    steps.forEach((step, stepIndex) => step.classList.toggle("active", stepIndex === index));
    progress.querySelector("span").textContent = `Step ${index + 1} of ${steps.length}`;
    progress.style.setProperty("--progress", `${((index + 1) / steps.length) * 100}%`);
    if (index > 0) form.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  steps.forEach((step, index) => {
    const actions = document.createElement("div");
    actions.className = "wizard-actions";

    if (index > 0) {
      const back = document.createElement("button");
      back.type = "button";
      back.className = "wizard-back";
      back.textContent = "Back";
      back.addEventListener("click", () => show(index - 1));
      actions.append(back);
    } else {
      actions.append(document.createElement("span"));
    }

    if (index < steps.length - 1) {
      const next = document.createElement("button");
      next.type = "button";
      next.textContent = "Continue";
      next.addEventListener("click", () => {
        const fields = [...step.querySelectorAll("input, select, textarea")];
        const invalid = fields.find((field) => !field.checkValidity());
        if (invalid) {
          invalid.reportValidity();
          return;
        }
        show(index + 1);
      });
      actions.append(next);
    } else {
      const submit = step.querySelector('button[type="submit"], button:not([type])');
      if (submit) actions.append(submit);
    }

    step.append(actions);
  });

  show(0);
})();
