// -----------------------------------------------------------------------------
// Texts shown to the user (action messages, connection status), in English and
// French. Never an entry typed in the configuration: only counts and the
// addresses the integration validated.
// -----------------------------------------------------------------------------

const list = (names) => names.join(', ');

const ago = (seconds) => {
  if (seconds < 60) {
    return { en: `${seconds} s ago`, fr: `il y a ${seconds} s` };
  }
  const minutes = Math.floor(seconds / 60);
  return { en: `${minutes} min ago`, fr: `il y a ${minutes} min` };
};

export const T = {
  dataUnreadable: {
    en: 'The saved data of the integration (/data/sky-q.json) cannot be read: it is left untouched and nothing is saved until it is fixed. The boxes are found again from the addresses and the search.',
    fr: "Les données enregistrées de l'intégration (/data/sky-q.json) sont illisibles : elles sont laissées telles quelles et rien n'est enregistré tant que ce n'est pas réparé. Les décodeurs sont retrouvés par les adresses et la recherche.",
  },
  dataCorrupt: {
    en: 'The saved data of the integration was not valid: it was moved to sky-q.json.bad. The boxes are found again from the addresses and the search.',
    fr: "Les données enregistrées de l'intégration n'étaient pas valides : elles ont été déplacées dans sky-q.json.bad. Les décodeurs sont retrouvés par les adresses et la recherche.",
  },
  invalidEntries: (count) => ({
    en: `${count} invalid address(es) ignored in the configuration: type IPv4 addresses or host names, separated by commas.`,
    fr: `${count} adresse(s) invalide(s) ignorée(s) dans la configuration : saisissez des adresses IPv4 ou des noms d'hôte, séparés par des virgules.`,
  }),
  configUnread: {
    en: 'The configuration could not be read from Gladys: asked again every 30 s. The boxes already known still take commands.',
    fr: "La configuration n'a pas pu être lue depuis Gladys : redemandée toutes les 30 s. Les décodeurs déjà connus acceptent toujours les commandes.",
  },
  noBox: {
    en: 'No Sky Q box yet: type its IP address in the configuration, or use "Find the boxes".',
    fr: "Aucun décodeur Sky Q pour l'instant : saisissez son adresse IP dans la configuration, ou utilisez « Chercher les décodeurs ».",
  },
  noneAnswers: (names) => ({
    en: `No Sky Q box answers: ${list(names)}. Check that they are plugged in and on the same network.`,
    fr: `Aucun décodeur Sky Q ne répond : ${list(names)}. Vérifiez qu'ils sont branchés et sur le même réseau.`,
  }),
  moved: (names) => ({
    en: `Another box answers at the address of: ${list(names)}. Run "Find the boxes" or type their new address.`,
    fr: `Un autre décodeur répond à l'adresse de : ${list(names)}. Lancez « Chercher les décodeurs » ou saisissez leur nouvelle adresse.`,
  }),
  unidentified: (hosts) => ({
    en: `A box answers at ${list(hosts)} without a readable serial number: it is not added.`,
    fr: `Un décodeur répond à ${list(hosts)} sans numéro de série lisible : il n'est pas ajouté.`,
  }),
  found: (boxes) =>
    boxes.length === 0
      ? {
          en: 'No Sky Q box found. Check that the boxes are on the same network, and type their IP address in the configuration if the network blocks the search.',
          fr: 'Aucun décodeur Sky Q trouvé. Vérifiez que les décodeurs sont sur le même réseau, et saisissez leur adresse IP dans la configuration si le réseau bloque la recherche.',
        }
      : {
          en: `${boxes.length} box(es): ${list(boxes)}. They are in the Discovery tab.`,
          fr: `${boxes.length} décodeur(s) : ${list(boxes)}. Ils sont dans l'onglet Découverte.`,
        },
  checkNone: {
    en: 'No box known yet.',
    fr: 'Aucun décodeur connu pour l’instant.',
  },
  checkLine: (box, reading, seconds) => {
    const when = seconds === undefined ? undefined : ago(seconds);
    const state = (() => {
      if (!reading) {
        return { en: 'not read yet', fr: 'pas encore lu' };
      }
      if (reading.online === false) {
        return { en: 'does not answer', fr: 'ne répond pas' };
      }
      if (reading.online === undefined) {
        return { en: 'answer not understood', fr: 'réponse incomprise' };
      }
      if (reading.on === true) {
        return { en: 'on', fr: 'allumé' };
      }
      if (reading.on === false) {
        return { en: 'in standby', fr: 'en veille' };
      }
      return { en: 'answers, power state unknown', fr: 'répond, état inconnu' };
    })();
    const name = `${box.serial} (${box.host || '?'})`;
    return {
      en: `${name}: ${state.en}${when ? `, ${when.en}` : ''}`,
      fr: `${name} : ${state.fr}${when ? `, ${when.fr}` : ''}`,
    };
  },
  check: (lines) => ({
    en: lines.map((l) => l.en).join(' | '),
    fr: lines.map((l) => l.fr).join(' | '),
  }),
};
