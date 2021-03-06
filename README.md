Fork of the original repo to develop a feature as a non-collaborator

## required changes from the original repo:
1) pull / download this repo

2) navigate to the vigiclient directory and run:
```javascript
npm install @abandonware/noble
```
3) make sure bluetooth is enabled in /boot/config.txt . the line should look like this:   
```bash
#dtoverlay=pi3-disable-bt
```
(bluetooth uses UART for communication)

4) enable the required service
```bash
sudo systemctl enable hciuart.service
```
5) reboot (starting the hciuart service manually often fails)

6) add a ble rssi bar graph to interface config -> RX -> VALEUR8 -> 4 -> 
```bash
,
      {
        "NOM": "BLE RSSI",
        "INIT": -95,
        "ECHELLEMIN": -95,
        "ECHELLEMAX": -55,
        "MIN": -95,
        "MAX": -55,
        "SIGNE": true,
        "NBCHIFFRES": 0,
        "UNITE": " dBm",
        "AFFICHAGE": "Barre"
      }
```
if those requirements are not met, any usage of noble will throw an error


# Make your own Vigibot.com raspberry PI robot

## Installation on a clean Raspbian Buster Lite

### Automatic installation

- Everything is already done, jump to the "Windows or Linux headless installation" on https://github.com/vigibot/vigimage

### Prerequisites for manual installation

- Flash the last Raspbian Buster Lite image: https://downloads.raspberrypi.org/raspbian_lite/images/raspbian_lite-2019-07-12 or https://www.vigibot.com/raspbian/raspbian_lite-2019-07-12
- Put your "wpa_supplicant.conf" and an empty "ssh" file inside the boot partition
- Connect to your Raspberry Pi via SSH
- sudo apt update
- sudo apt upgrade

### Manual installation

- wget https://www.vigibot.com/vigiclient/install.sh
- sudo bash install.sh
- sudo nano /boot/robot.json
- Change the "Demo" login and the "Default" password to match your own robot account
- sudo reboot
- Take a look at the default server https://www.vigibot.com
