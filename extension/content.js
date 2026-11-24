// Injected as a classic script into contact pages. Reads, fills and submits forms.
// Scoring happens in the background worker, which imports src/lib/score.js.
(() => {
  if (window.__fillHeroLoaded) return;
  window.__fillHeroLoaded = true;

  const CAPTCHA_CLASS = /g-recaptcha|h-captcha|cf-turnstile/i;
  const CAPTCHA_SRC = /recaptcha|hcaptcha|turnstile/i;

  function labelFor(el) {
    if (el.id) {
      const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (l) return l.textContent.trim();
    }
    const parent = el.closest("label");
    return parent ? parent.textContent.trim() : "";
  }

  function describe(el) {
    const label = [labelFor(el), el.getAttribute("aria-label") || "", el.getAttribute("title") || ""].filter(Boolean).join(" ");
    return {
      tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : el.tagName === "SELECT" ? "select" : "text")).toLowerCase(),
      name: el.getAttribute("name") || "",
      id: el.id || "",
      placeholder: el.getAttribute("placeholder") || "",
      autocomplete: el.getAttribute("autocomplete") || "",
      label,
      required: !!el.required,
    };
  }

  function formList() {
    return Array.from(document.querySelectorAll("form"));
  }

  // Look up a form by its position in the document. Re-tags every form first, so a form
  // that a page script re-rendered (and so lost its tag) is still found.
  function getForm(formIndex) {
    const forms = formList();
    forms.forEach((f, i) => f.setAttribute("data-fh-index", String(i)));
    return forms[formIndex] || null;
  }

  function captchaPresent() {
    return (
      Array.from(document.querySelectorAll("iframe")).some((f) => CAPTCHA_SRC.test(f.src || "")) ||
      Array.from(document.querySelectorAll("[class]")).some((el) => CAPTCHA_CLASS.test(el.className.toString()))
    );
  }

  function scan() {
    const captcha = captchaPresent();

    const forms = formList().map((form, index) => {
      form.setAttribute("data-fh-index", String(index));
      const els = Array.from(form.querySelectorAll("input,textarea,select"));
      return {
        index,
        hasPassword: els.some((e) => (e.getAttribute("type") || "").toLowerCase() === "password"),
        action: form.getAttribute("action") || "",
        id: form.id || "",
        className: form.getAttribute("class") || "",
        fields: els.map(describe),
      };
    });
    return { captcha, url: location.href, lang: document.documentElement.lang || "", forms };
  }

  // Dropdowns: the option whose value or text matches exactly, else the first whose text contains it.
  function findOption(el, value) {
    const want = String(value).trim().toLowerCase();
    const opts = Array.from(el.options);
    return (
      opts.find((o) => o.value.trim().toLowerCase() === want || o.text.trim().toLowerCase() === want) ||
      opts.find((o) => o.text.trim().toLowerCase().includes(want)) ||
      null
    );
  }

  // Does the field currently hold the value we want?
  function holds(el, value) {
    if (el.tagName === "SELECT") {
      const target = findOption(el, value);
      return !!target && el.value === target.value;
    }
    return el.value === value;
  }

  function setValue(el, value) {
    if (el.tagName === "SELECT") {
      const target = findOption(el, value);
      if (target) el.value = target.value;
    } else {
      const proto = el.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
      setter.call(el, value);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // fills: [{ index: <field index in form>, value: string }]
  function fill(formIndex, fills) {
    const form = getForm(formIndex);
    if (!form) return { ok: false, reason: "form-not-found" };
    const els = Array.from(form.querySelectorAll("input,textarea,select"));
    const filled = [];
    const missing = [];
    for (const { index, value } of fills) {
      const el = els[index];
      if (!el) {
        missing.push(index);
        continue;
      }
      setValue(el, value);
      filled.push(index);
    }
    return { ok: missing.length === 0, filled, missing };
  }

  // Some page builders (Wix and others) re-render fields after load and can wipe a value
  // written too early. Re-query the fields and re-apply any value that did not stick.
  // Resolves after the values hold for two checks in a row, or after 6 seconds.
  function fillAndVerify(formIndex, fills) {
    return new Promise((resolve) => {
      const started = Date.now();
      let cleanTicks = 0;
      let missing = [];
      let unverified = [];
      let reapplied = 0;

      const tick = () => {
        const form = getForm(formIndex);
        if (!form) {
          // The form may be mid-render; keep looking until the time budget runs out.
          if (Date.now() - started >= 6000) return finish(false);
          return setTimeout(tick, 400);
        }
        const els = Array.from(form.querySelectorAll("input,textarea,select"));
        missing = [];
        unverified = [];
        for (const { index, value } of fills) {
          const el = els[index];
          if (!el) {
            missing.push(index);
            continue;
          }
          if (!holds(el, value)) {
            setValue(el, value);
            reapplied += 1;
            unverified.push(index);
          }
        }
        cleanTicks = unverified.length === 0 && missing.length === 0 ? cleanTicks + 1 : 0;
        const elapsed = Date.now() - started;
        if ((cleanTicks >= 2 && elapsed >= 600) || elapsed >= 6000) return finish(true);
        setTimeout(tick, 200);
      };

      const finish = (formFound) => {
        if (!formFound) return resolve({ ok: false, reason: "form-not-found", missing, unverified, reapplied });
        resolve({ ok: missing.length === 0 && unverified.length === 0, missing, unverified, reapplied });
      };

      tick();
    });
  }

  // How long a submit is watched for a confirmation. Slow sites need this room.
  const CONFIRM_MS = 12000;

  // Wording a site shows once a message has gone through (English and common other languages).
  const SUCCESS_TEXT =
    /thank you|thank-you|thanks for (your|contacting|getting|reaching)|message (has been |was |have been )?(sent|received|submitted)|successfully (sent|submitted|received)|we (have )?(received|got) your|your (message|enquiry|inquiry|request|submission) (has been|was|have been) (sent|received|submitted)|merci|danke|vielen dank|gracias|grazie|obrigad/i;
  const SUCCESS_PATH = /thank|success|sent|merci|danke|gracias|confirm/i;
  // Wording a site shows when it refuses a submit.
  const ERROR_TEXT =
    /this field is required|field is required|please (enter|fill|provide|select|check|complete|correct)|is invalid|not valid|try again|could not be sent|was not sent|failed to send|error/i;
  const ALERT_SELECTOR =
    "[role='alert'], [aria-live='assertive'], .error, .errors, .invalid-feedback, .form-error, .field-error, .alert-danger, .wpcf7-not-valid-tip, .wpcf7-response-output, .has-error, .is-invalid";

  const bodyText = () => (document.body ? document.body.innerText : "");
  const alertText = () => Array.from(document.querySelectorAll(ALERT_SELECTOR)).map((el) => el.innerText || "").join(" ").trim();

  // Looks at the page now and says what it shows about the submit.
  // outcome: "confirmed" (the site said so), "rejected" (the site refused it), or "unverified" (no sign either way).
  // before: what the page showed before the submit. Text already there does not count as a confirmation.
  function readOutcome(formIndex, startUrl, before) {
    const form = getForm(formIndex);
    const landed = location.href !== startUrl;
    const text = bodyText();
    const thanksNow = SUCCESS_TEXT.test(text) && !(before.success && !landed);
    const pathSaysSent = landed && SUCCESS_PATH.test(location.pathname + location.search);
    if (thanksNow || pathSaysSent) {
      return { outcome: "confirmed", reason: thanksNow ? "confirmation text shown" : `landed on ${location.pathname}` };
    }

    const alerts = alertText();
    const errorNow = ERROR_TEXT.test(alerts) && alerts !== before.alerts;
    const blocked = !!form && form.querySelectorAll(":invalid").length > 0; // the browser refused to send it
    const captchaNow = !!form && captchaPresent();
    if (form && (blocked || errorNow || captchaNow)) {
      const why = blocked ? "a required field is empty or invalid" : captchaNow ? "a CAPTCHA appeared" : "the site showed an error";
      return { outcome: "rejected", reason: why };
    }
    return {
      outcome: "unverified",
      reason: landed ? "landed on a page with no confirmation" : form ? "no confirmation, and the form is still there" : "form gone, no confirmation",
    };
  }

  function submit(formIndex, startUrl) {
    return new Promise((resolve) => {
      const form = getForm(formIndex);
      if (!form) return resolve({ outcome: "unverified", reason: "form-not-found" });

      const before = { success: SUCCESS_TEXT.test(bodyText()), alerts: alertText() };
      if (typeof form.requestSubmit === "function") form.requestSubmit();
      else form.submit();

      const started = Date.now();
      const timer = setInterval(() => {
        const verdict = readOutcome(formIndex, startUrl, before);
        const waited = Date.now() - started;
        if (verdict.outcome === "confirmed" || verdict.outcome === "rejected" || waited >= CONFIRM_MS) {
          clearInterval(timer);
          return resolve(verdict);
        }
      }, 250);
    });
  }

  // Reads the confirmation on the page a submit landed on. Used when the submit's own page has gone away.
  function confirm(formIndex, startUrl) {
    return readOutcome(formIndex, startUrl, { success: false, alerts: "" });
  }

  window.__fillHero = { scan, fill, fillAndVerify, submit, confirm };

  if (typeof chrome === "undefined" || !chrome.runtime || !chrome.runtime.onMessage) return;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg.type === "scan") {
      sendResponse(scan());
      return false;
    }
    if (msg.type === "fill") {
      fillAndVerify(msg.formIndex, msg.fills).then(sendResponse);
      return true; // async response
    }
    if (msg.type === "submit") {
      submit(msg.formIndex, location.href).then(sendResponse);
      return true; // async response
    }
    if (msg.type === "confirm") {
      sendResponse(confirm(msg.formIndex, msg.startUrl));
      return false;
    }
    return false;
  });
})();
