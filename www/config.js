// Adresse du serveur de jeu (même principe que la Dame de Pique).
// - Dans un navigateur, la page est servie par le serveur lui-même : on se connecte
//   à la même adresse (valeur vide).
// - Dans l'app Android (Capacitor), on se connecte au serveur indiqué ici, en http.
//   Pour tester avec le serveur sur le PC : 'http://localhost:3002' + adb reverse tcp:3002 tcp:3002
//   Si l'adresse du serveur change, modifier SERVER_URL_APP puis regénérer l'APK.
(function () {
  var SERVER_URL_APP = 'http://82.66.218.220:3002';
  var isNativeApp = !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
  window.SERVER_URL = isNativeApp ? SERVER_URL_APP : '';
})();
