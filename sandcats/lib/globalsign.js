var soap = Meteor.npmRequire('soap');
var globalsignWsdls = {
  'dev': 'https://testsystem.globalsign.com/kb/ws/v1/ManagedSSLService?wsdl',
  'prod': null  // for now.
};

// We use _client to cache a working SOAP client to the particular
// GlobalSign API endpoint we need.
//
// Do not access it directly. Access it via getClient() so it can be
// created if needed.
var _client = null;
function getClient() {
  if (! Meteor.settings.GLOBALSIGN_USERNAME) {
    throw new Error("Cannot construct client since we have no username configured.");
  }

  if (! Meteor.settings.GLOBALSIGN_DOMAIN) {
    throw new Error("Cannot construct client since we have no domain configured.");
  }

  if (! Meteor.settings.GLOBALSIGN_DEV_OR_PROD) {
    throw new Error("Cannot construct client since we don't know if dev or prod.");
  }

  if (! process.env.GLOBALSIGN_PASSWORD) {
    throw new Error("Cannot construct client since we have no password available.");
  }

  if (! _client) {
    _client = Meteor.wrapAsync(soap.createClient)(globalsignWsdls[Meteor.settings.GLOBALSIGN_DEV_OR_PROD]);
  }
  return _client;
}

// For custom certificate validity, GlobalSign's API wants us to
// provide a months value that is >= 6. So we use this one.
var DUMMY_MONTHS_VALUE = 6;

// Use this function to get information about a domain.
getMsslDomainInfo = function(domain) {
  var wrapped = Meteor.wrapAsync(getClient().GetMSSLDomains);
  var args = {
    'Request': {
      'QueryRequestHeader': {
        'AuthToken': {
          'UserName': Meteor.settings.GLOBALSIGN_USERNAME,
          'Password': process.env.GLOBALSIGN_PASSWORD
        }}}};
  var result = wrapped(args);
  var usefulResult = {};
  for (var i = 0; i < result.Response.SearchMsslDomainDetails.SearchMsslDomainDetail.length; i++) {
    var detail = result.Response.SearchMsslDomainDetails.SearchMsslDomainDetail[i];
    if (detail.MSSLDomainName == domain) {
      usefulResult['MSSLDomainID'] = detail.MSSLDomainID;
      usefulResult['MSSLProfileID'] = detail.MSSLProfileID;
      break;
    }
  }

  return usefulResult;
}

// Like _client, _myDomainInfo caches information to avoid unnecessary
// fetching. Don't access _myDomainInfo directly; access it via
// getMyDomainInfo().
var _myDomainInfo;
getMyDomainInfo = function() {
  if (! _myDomainInfo) {
    _myDomainInfo = getMsslDomainInfo(Meteor.settings.GLOBALSIGN_DOMAIN);
  }
  return _myDomainInfo;
}

// This function generates the list of arguments we provide to PVOrder
// by GlobalSign.

// This function returns an object containing just the
// OrderRequestParameter data we need to pass to the GlobalSign
// API. Its input is the text of a certificate signing request (CSR).
//
// It assumes any authorization validation has already been done on
// the CSR data. If not, treat its output with caution.
getOrderRequestParameter = function(csrText, now) {
  // We take now as an optional parameter, so we can unit-test how the
  // function operates in the case of various times.
  if (! now) {
    now = new Date();
  }
  now = new Date(now.getTime() + (1000 * 1000));

  // The end date is set to 9 days in the future. This is due to a
  // limitation of the GlobalSign API. Particularly:
  //
  // - If we provide a NotBefore value, it has to be about an hour in
  //   the future, and
  //
  // - If we omit NotBefore, then NotAfter has to be about 9 days in
  //   the future.
  //
  // We treat these as 7-day certificates for the purpose of planning
  // renewals and generating reports.
  var end = new Date(now.getTime() + (9*86400000));
  var args = {
    'OrderRequestParameter': {
      'ProductCode': 'PV',
      'OrderKind': 'new',
      'ValidityPeriod': {
        'Months': DUMMY_MONTHS_VALUE,
        'NotBefore': null,
        'NotAfter': end.toISOString()
      },
      'Options': [
        {'Option': {
          'OptionName': 'VPC',
          'OptionValue': 'true'
        }}],
      'BaseOptions': [
        {'Option': {
          'OptionName': 'wildcard',
          'OptionValue': 'true'
        }}],
      'CSR': csrText
    }
  };
  console.log(args);
  return args;
}

// This function calculates the full argument set required for
// PVOrder, including the AuthToken in the
// OrderRequestHeader. Therefore it does require secrets and can't
// be as easily unit-tested.
getAllSignCsrArgs = function(domainInfo, csrText) {
  var args = {
    'MSSLDomainID': domainInfo.MSSLDomainID,
    'MSSLProfileID': domainInfo.MSSLProfileID,
    'OrderRequestHeader': {
      'AuthToken': {
        'UserName': Meteor.settings.GLOBALSIGN_USERNAME,
        'Password': process.env.GLOBALSIGN_PASSWORD
      }
    },
    // Note: ContactInfo is ignored by GlobalSign in the ManagedSSL
    // product, and ManagedSSL is the product of theirs that we use.
    'ContactInfo': {
      'FirstName': 'Sandstorm',
      'LastName': 'Development Group',
      'Phone': '+1 585-506-8865',
      'Email': 'certmaster@sandstorm.io'}
  };
  args = _.extend(args, getOrderRequestParameter(csrText));
  var finalArgs = {'Request': args};
  console.log(JSON.stringify(finalArgs));
  return finalArgs;
};

issueCertificate = function(csrText) {
  var domainInfo = getMyDomainInfo();
  var args = getAllSignCsrArgs(domainInfo, csrText);
  var wrapped = Meteor.wrapAsync(getClient().PVOrder);
  var globalsignResponse = wrapped(args);
  if (globalsignResponse.Response.OrderResponseHeader.SuccessCode == -1) {
    console.log(JSON.stringify(globalsignResponse.Response.OrderResponseHeader.Errors));
  }
  return globalsignResponse;
};