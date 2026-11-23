(() => {
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
