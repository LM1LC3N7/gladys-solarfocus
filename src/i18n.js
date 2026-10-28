// -----------------------------------------------------------------------------
// Runtime texts (English and French): device, feature and mode names, the
// status of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Solarfocus heating', 'Chauffage Solarfocus');

export const FEATURE_NAMES = {
  [F.TEMP_OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.HP_STATE]: both('Heat pump state', 'État de la pompe à chaleur'),
  [F.HP_TEMP_FLOW]: both('Heat pump flow temperature', 'Température de départ de la PAC'),
  [F.HP_TEMP_RETURN]: both('Heat pump return temperature', 'Température de retour de la PAC'),
  [F.HP_EVU_LOCK]: both('Utility lock (EVU) active', 'Blocage fournisseur (EVU) actif'),
  [F.HP_POWER]: both('Electrical power of the heat pump', 'Puissance électrique de la PAC'),
  [F.BOILER_TEMP]: both('Boiler temperature', 'Température de la chaudière'),
};

const COMPONENT_NAMES = {
  circuit: both('Heating circuit', 'Circuit de chauffage'),
  dhw: both('Hot water tank', 'Ballon d’eau chaude'),
  buffer: both('Buffer tank', 'Ballon tampon'),
};

const SUFFIX_NAMES = {
  circuit: {
    mode: both('mode', 'mode'),
    setpoint: both('room setpoint', 'consigne ambiante'),
    'temperature-flow': both('flow temperature', 'température de départ'),
    'temperature-room': both('room temperature', 'température ambiante'),
  },
  dhw: {
    mode: both('release mode', 'mode de libération'),
    setpoint: both('setpoint', 'consigne'),
    temperature: both('temperature', 'température'),
  },
  buffer: {
    'temperature-top': both('temperature (top)', 'température (haut)'),
    'temperature-bottom': both('temperature (bottom)', 'température (bas)'),
  },
};

/** "Heating circuit 1: mode". */
export const componentFeatureName = (kind, n, suffix) =>
  both(
    `${COMPONENT_NAMES[kind].en} ${n}: ${SUFFIX_NAMES[kind][suffix].en}`,
    `${COMPONENT_NAMES[kind].fr} ${n} : ${SUFFIX_NAMES[kind][suffix].fr}`,
  );

/** The operating modes of a heating circuit (32603). */
export const CIRCUIT_MODE_NAMES = {
  continuous: both('Continuous heating', 'Chauffage permanent'),
  setback: both('Setback', 'Réduit'),
  automatic: both('Automatic (time program)', 'Automatique (programme horaire)'),
  off: both('Off (frost protection only)', 'Arrêt (hors gel seulement)'),
};

/** The release modes of a hot water tank (32002). */
export const DHW_MODE_NAMES = {
  'always-off': both('Always off', 'Toujours arrêté'),
  'always-on': both('Always on', 'Toujours en marche'),
  'monday-sunday': both('Monday to Sunday program', 'Programme lundi à dimanche'),
  'block-wise': both(
    'Program by blocks (Mon-Fri, Sat-Sun)',
    'Programme par blocs (lun-ven, sam-dim)',
  ),
  'day-wise': both('Program day by day', 'Programme jour par jour'),
};

/** The states of the vampair heat pump (2330), for the status line. */
export const HEATPUMP_STATE_NAMES = {
  standby: both('standby', 'veille'),
  heating: both('heating', 'chauffage'),
  'heating-dhw': both('heating, hot water charge', 'chauffage, charge d’eau chaude'),
  cooling: both('cooling', 'rafraîchissement'),
  manual: both('manual operation', 'fonctionnement manuel'),
  'evu-lock': both('utility lock', 'blocage fournisseur'),
  'no-time-release': both('no time release, off', 'pas de plage horaire, arrêt'),
  'outdoor-lockout': both(
    'outdoor temperature lockout, off',
    'blocage par la température extérieure, arrêt',
  ),
  'electric-heater': both('electric heater on', 'appoint électrique en marche'),
  'external-boiler': both('external boiler on, off', 'chaudière externe en marche, arrêt'),
  'cooling-request': both('cooling request', 'demande de rafraîchissement'),
  'manual-power': both('manual power', 'puissance manuelle'),
  off: both('off', 'arrêtée'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Solarfocus eco manager-touch (Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre régulation Solarfocus eco manager-touch (Modbus TCP), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 247 (1 on an eco manager-touch). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 247 (1 sur une eco manager-touch). Rien n’est lu.',
  ),
  badCounts: both(
    'Counts of circuits, tanks or buffers: whole numbers (circuits 0 to 8, hot water tanks and buffers 0 to 4); a wrong one counts as its default.',
    'Nombres de circuits, ballons ou tampons : des nombres entiers (circuits 0 à 8, ballons d’eau chaude et tampons 0 à 4) ; une valeur fausse compte comme sa valeur par défaut.',
  ),
  badGenerator: both(
    'Unknown heat generator: none is read.',
    'Générateur de chaleur inconnu : aucun n’est lu.',
  ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: tried again every 30 s. A stop (circuit off, hot water always off) still goes to the last controller read.',
    'La configuration n’a pas pu être lue depuis Gladys : nouvel essai toutes les 30 s. Un arrêt (circuit à l’arrêt, eau chaude toujours arrêtée) part quand même vers la dernière régulation lue.',
  ),
  connecting: both('Reading the controller…', 'Lecture de la régulation…'),
  waiting: (wait) =>
    both(
      `Next read of the controller in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la régulation dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, that "Modbus TCP" is activated on the eco manager-touch (installer menu), and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, que « Modbus TCP » est activé sur l’eco manager-touch (menu installateur), et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The controller answered badly (${reason}); next try in ${wait.en}.`,
      `La régulation a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  missingBlocks: (names) => both(`Not read this time: ${names}.`, `Non lus cette fois : ${names}.`),
  flowSetpoints: (list) =>
    both(
      `A flow setpoint written by another Modbus client is active on circuit ${list}: its mode is not changed by Gladys (a stop still goes).`,
      `Une consigne de départ écrite par un autre client Modbus est active sur le circuit ${list} : Gladys n’en change pas le mode (un arrêt part quand même).`,
    ),
  stopsPending: (list) =>
    both(
      `Stop not confirmed by the controller: ${list}.`,
      `Arrêt non confirmé par la régulation : ${list}.`,
    ),
  summary: (values) => {
    const state = values.hpState ? HEATPUMP_STATE_NAMES[values.hpState] : undefined;
    const outdoor =
      values.outdoor === undefined
        ? both('', '')
        : both(` Outdoor ${values.outdoor} °C.`, ` Extérieur ${values.outdoor} °C.`);
    return state
      ? both(`Heat pump: ${state.en}.${outdoor.en}`, `PAC : ${state.fr}.${outdoor.fr}`)
      : both(`Solarfocus read.${outdoor.en}`, `Solarfocus lue.${outdoor.fr}`);
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badNumber: both('Not a number: not sent.', 'Ce n’est pas un nombre : non envoyé.'),
  badStep: (step) =>
    both(`Steps of ${step} °C only: not sent.`, `Par pas de ${step} °C seulement : non envoyé.`),
  outOfRange: (min, max) =>
    both(
      `Out of range (${min} to ${max} °C): not sent.`,
      `Hors limites (${min} à ${max} °C) : non envoyé.`,
    ),
  dhwCap: (cap) =>
    both(
      `Above the hot water ceiling of the configuration (${cap} °C, 65 °C at most): not sent.`,
      `Au-dessus du plafond d’eau chaude de la configuration (${cap} °C, 65 °C au plus) : non envoyé.`,
    ),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  noComponent: both(
    'This circuit or tank is not in the configuration any more: not sent.',
    'Ce circuit ou ce ballon n’est plus dans la configuration : non envoyée.',
  ),
  flowSetpoint: both(
    'A flow setpoint written by another Modbus client is active on this circuit: Gladys does not override it, change the mode there. Not sent.',
    'Une consigne de départ écrite par un autre client Modbus est active sur ce circuit : Gladys ne la remplace pas, changez le mode depuis ce client. Non envoyée.',
  ),
  unknownValue: both(
    'The current value could not be read just before: command not sent.',
    'La valeur actuelle n’a pas pu être relue juste avant : commande non envoyée.',
  ),
  stopPending: both(
    'Stop not sent yet, still trying to reach the controller: check its state in a few seconds.',
    'Arrêt pas encore envoyé, la régulation est encore en cours de connexion : vérifiez son état dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Too many commands to the controller are still waiting: not sent.',
    'Trop de commandes vers la régulation sont encore en attente : non envoyée.',
  ),
  protectMeanwhile: both(
    'A stop was sent meanwhile: not sent.',
    'Un arrêt a été envoyé entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The controller answered too slowly to send the command in time: not sent.',
    'La régulation a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current value could not be read just before (${reason}): command not sent.`,
      `La valeur actuelle n’a pas pu être relue juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The controller refused the command (${reason}): not applied.`,
      `La régulation a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The controller could not be reached (${reason}): command not sent.`,
      `La régulation n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the heating in a minute.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état du chauffage dans une minute.`,
    ),
  queued: both(
    'Command waiting its turn behind other commands (a scene): it is sent within 15 s of the click, or not at all; check the state of the heating in a few seconds.',
    'Commande en attente derrière d’autres commandes (une scène) : elle part dans les 15 s qui suivent le clic, ou pas du tout ; vérifiez l’état du chauffage dans quelques secondes.',
  ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
  readBackDiffers: both(
    'the value read back is not the one asked',
    'la valeur relue n’est pas celle demandée',
  ),
};
