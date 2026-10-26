// -----------------------------------------------------------------------------
// Answers of a Sky Q box, shaped like the ones pyskyqremote reads (its field
// names and its SOAP envelope), with made-up values.
// -----------------------------------------------------------------------------

export const SERIAL = '0123456789A';
export const OTHER_SERIAL = '9876543210B';
export const HOST = '192.168.1.50';
export const CONTROL_PATH = '/c8f3e1a0-skyplay';

export const deviceInformation = ({ serial = SERIAL, bouquet = 4101, subbouquet = 1 } = {}) => ({
  ASVersion: 'Q240.000.00.00',
  IPAddress: '10.9.9.9',
  countryCode: 'GBR',
  gateway: 'true',
  hardwareName: 'ES240',
  modelNumber: 'Q240',
  serialNumber: serial,
  versionNumber: '32B12D',
  bouquet,
  subbouquet,
});

export const systemInformation = ({ standby = false, deviceType = 'GATEWAYSTB' } = {}) => ({
  activeStandby: standby,
  deviceType,
  gatewayIPAddress: '192.168.1.50',
  hardwareModel: 'ES240',
  manufacturer: 'Sky',
  wakeReason: 'POWERBUTTON',
  systemUptime: 1234,
  hdrCapable: true,
  uhdCapable: true,
});

export const CHANNELS = [
  { c: '101', t: 'BBC One HD', sid: '2153', sf: 'hd' },
  { c: '102', t: 'BBC Two HD', sid: '2154', sf: 'hd' },
  { c: '1001', t: 'Radio One', sid: '3001', sf: 'au' },
];

export const services = () => ({ documentId: '1', services: CHANNELS });

export const storage = ({ max = 1000, used = 420 } = {}) => ({
  userQuotaMax: max,
  userQuotaUsed: used,
});

export const pvrDetails = (title = 'Planet Earth') => ({
  details: { t: title, cn: 'BBC One HD', sy: 'Nature.', status: 'RECORDED', pvrid: 'P28E1A3C5' },
});

const envelope = (inner) =>
  '<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"' +
  ` s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>${inner}</s:Body></s:Envelope>`;

export const transportInfo = (state = 'PLAYING') =>
  envelope(
    '<u:GetTransportInfoResponse xmlns:u="urn:schemas-nds-com:service:SkyPlay:2">' +
      `<CurrentTransportState>${state}</CurrentTransportState>` +
      '<CurrentTransportStatus>OK</CurrentTransportStatus><CurrentSpeed>1</CurrentSpeed>' +
      '</u:GetTransportInfoResponse>',
  );

export const mediaInfo = (uri = 'xsi://869') =>
  envelope(
    '<u:GetMediaInfoResponse xmlns:u="urn:schemas-nds-com:service:SkyPlay:2">' +
      `<NrTracks>1</NrTracks><CurrentURI>${uri}</CurrentURI>` +
      '</u:GetMediaInfoResponse>',
  );

/** A description file: the SkyControl device with its SkyPlay service, or another device. */
export function description({ sky = true, controlURL = CONTROL_PATH } = {}) {
  const type = sky
    ? 'urn:schemas-nds-com:device:SkyControl:2'
    : 'urn:schemas-upnp-org:device:MediaServer:1';
  return (
    '<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><device>' +
    `<deviceType>${type}</deviceType><friendlyName>Sky box</friendlyName>` +
    '<serviceList>' +
    '<service><serviceType>urn:schemas-nds-com:service:SkyRC:2</serviceType>' +
    '<serviceId>urn:nds-com:serviceId:SkyRC</serviceId><controlURL>/rc</controlURL></service>' +
    '<service><serviceType>urn:schemas-nds-com:service:SkyPlay:2</serviceType>' +
    `<serviceId>urn:nds-com:serviceId:SkyPlay</serviceId><controlURL>${controlURL}</controlURL></service>` +
    '</serviceList></device></root>'
  );
}
