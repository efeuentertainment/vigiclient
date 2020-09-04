const noble = require('@abandonware/noble');

noble.on('stateChange', function (state) {
  if (state === 'poweredOn') {
    noble.startScanning();
    //noble.startScanning([], true)
    //allows dubplicates while scanning
  } else {
    noble.stopScanning();
  }
});

noble.on('discover', function (peripheral) {
  console.info(`peripheral discovered (${peripheral.id} with address <${peripheral.address}, ${peripheral.addressType}>, connectable ${peripheral.connectable}, RSSI ${peripheral.rssi}:`);
  console.info('\thello my local name is:');
  console.info(`\t\t${peripheral.advertisement.localName}`);
  console.info('\tcan I interest you in any of the following advertised services:');
  console.info(`\t\t${JSON.stringify(peripheral.advertisement.serviceUuids)}`);

  const serviceData = peripheral.advertisement.serviceData;
  if (serviceData && serviceData.length) {
    console.info('\there is my service data:');
    for (const i in serviceData) {
      console.info(`\t\t${JSON.stringify(serviceData[i].uuid)}: ${JSON.stringify(serviceData[i].data.toString('hex'))}`);
    }
  }
  if (peripheral.advertisement.manufacturerData) {
    console.info('\there is my manufacturer data:');
    console.info(`\t\t${JSON.stringify(peripheral.advertisement.manufacturerData.toString('hex'))}`);
  }
  if (peripheral.advertisement.txPowerLevel !== undefined) {
    console.info('\tmy TX power level is:');
    console.info(`\t\t${peripheral.advertisement.txPowerLevel}`);
  }

  console.info();
});
