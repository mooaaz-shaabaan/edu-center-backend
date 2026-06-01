// src/utils/portalCode.js
// بيولّد كود 6 أرقام عشوائي للبورتال

const generatePortalCode = () => {
  return Math.floor(100000 + Math.random() * 900000).toString();
};

module.exports = { generatePortalCode };
