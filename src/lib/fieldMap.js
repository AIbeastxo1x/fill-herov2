// Classify a form field descriptor into a contact-form role.
// Labels are matched in English and common European languages, without network access.

// Order matters: more specific roles are checked before the generic "name".
// Each group is [role, keywords]. Keywords are matched after normalize().
const KEYWORDS = [
  // Last name first: "cognome" and "nachname" would otherwise match the first-name words.
  ["lastName", ["last name", "lastname", "surname", "family name", "nom de famille", "nachname", "apellido", "cognome", "achternaam", "sobrenome"]],
  // Full-name phrases before the first-name words ("nombre completo" contains "nombre").
  ["name", ["full name", "fullname", "nome completo", "nombre completo", "vollständiger name"]],
  ["firstName", ["first name", "firstname", "given name", "prénom", "prenom", "vorname", "voornaam", "nombre", "nome"]],
  ["email", ["email", "e-mail", "courriel", "correo", "posta elettronica", "e-mailadres", "correio"]],
  ["phone", ["phone", "tel", "téléphone", "telephone", "teléfono", "telefono", "telefoon", "telefon"]],
  ["company", ["company", "organization", "organisation", "business", "société", "societe", "entreprise", "firma", "unternehmen", "empresa", "azienda", "bedrijf"]],
  ["subject", ["subject", "topic", "reason", "objet", "sujet", "betreff", "asunto", "oggetto", "onderwerp", "assunto"]],
  ["jobTitle", ["job title", "jobtitle", "position", "title", "poste", "cargo", "berufsbezeichnung"]],
  ["country", ["country", "pays", "país", "paese", "land"]],
  ["address", ["address", "adresse", "dirección", "indirizzo", "adres", "endereço", "street"]],
  // Address parts come after "address", so "Postal address" still means the full address.
  ["zip", ["zip", "postal code", "postcode", "post code", "postal", "postleitzahl", "plz", "código postal", "codigo postal", "code postal", "cap postale"]],
  ["city", ["city", "town", "ville", "ciudad", "città", "citta", "stadt", "plaats", "cidade"]],
  ["state", ["state", "province", "région", "region", "provincia", "estado", "bundesland", "staat"]],
  ["message", ["message", "comment", "inquir", "enquir", "question", "details", "how can we help", "préciser", "precis", "nachricht", "mensaje", "messaggio", "bericht", "mensagem", "commentaire", "kommentar", "opmerking", "anfrage"]],
  ["name", ["name", "nom"]],
].map(([role, words]) => [role, words.map(normalize)]);

// Lowercase, turn hyphens and underscores into spaces: "first-name" -> "first name".
function normalize(s) {
  return String(s ?? "").toLowerCase().replace(/[-_]/g, " ");
}

// Role from the field's label, name, id, placeholder and autocomplete, or "unknown".
function roleFromText(d) {
  const haystack = normalize([d.name, d.id, d.placeholder, d.label, d.autocomplete].join(" "));
  for (const [role, words] of KEYWORDS) {
    if (words.some((k) => haystack.includes(k))) return role;
  }
  return "unknown";
}

export function classifyField(d) {
  const type = String(d.type ?? "").toLowerCase();
  const tag = String(d.tag ?? "").toLowerCase();

  if (type === "hidden") return "hidden";
  // CAPTCHA responses and anti-spam honeypot fields are never filled.
  if (/g-recaptcha-response|h-captcha-response|honeypot|ak_hp|_hp_/i.test(String(d.name ?? "") + String(d.id ?? ""))) return "hidden";
  if (type === "submit" || type === "button" || type === "image" || type === "reset") return "submit";
  if (type === "checkbox" || type === "radio") return "consent";
  if (tag === "select") return roleFromText(d); // dropdowns: country, job title, etc.
  if (tag === "textarea") {
    // A textarea is a message box, except when it is clearly an address (e.g. "Address").
    // Its label may mention other words ("préciser l'objet"), so only address is taken from the label.
    return roleFromText(d) === "address" ? "address" : "message";
  }
  if (type === "email") return "email";
  if (type === "tel") return "phone";
  return roleFromText(d);
}
