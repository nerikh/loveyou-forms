const publicIp = require('public-ip');


const devKeys = () => {

  const keys = async () => {
    if (await publicIp.v4()) {
      const ip = await publicIp.v4();
      return ip;
    } else if (await publicIp.v6()) {
      const ip = await publicIp.v6();
      return ip;
    } else {
      return 'IP Address not found!';
    }
  }

  return ({
    loveyouforms: './dev/loveyouforms-package'
 //   myIp
  })
}

const prodKeys = {
  loveyouforms: 'loveyouforms',
}

if (process.env.NODE_ENV === "production") {
  module.exports = prodKeys;
} else {
  module.exports = devKeys();
}