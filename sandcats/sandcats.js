if (Meteor.isServer) {

  Meteor.startup(function () {
    // Validate that the config file contains the data we need.
    validateSettings();

    // Create our DNS zone for PowerDNS, if necessary.
    mysqlQuery = createWrappedQuery();
    createDomainIfNeeded(mysqlQuery);

    Router.map(function() {
      this.route('register', {
        path: '/register',
        where: 'server',
        action: function() {
          doRegister(this.request, this.response);
        }
      });
    });
  });
}
