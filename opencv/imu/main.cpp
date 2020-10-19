#include "../../frame.hpp"
#include "main.hpp"

void signal_callback_handler(int signum) {
 fprintf(stderr, "Caught signal %d\n", signum);
 run = false;
}

bool readModem(int fd) {
 uint8_t octet;
 static uint8_t pos = 0;
 uint8_t p;

 while(serialDataAvail(fd)) {
  octet = serialGetchar(fd);

  switch(pos) {

   case 0:
    if(octet == '$')
     pos = 1;
    break;

   case 1:
    if(octet == 'S')
     pos = 2;
    else
     pos = 0;
    break;

   case 2:
   case 3:
    if(octet == ' ')
     pos++;
    else
     pos = 0;
    break;

   default:
    remoteFrame.bytes[pos++] = octet;
    if(pos == REMOTEFRAMESIZE) {
     pos = 0;
     serialFlush(fd);
     return true;
    }

  }
 }

 return false;
}

void writeModem(int fd) {
 for(int i = 0; i < TELEMETRYFRAMESIZE; i++)
  serialPutchar(fd, telemetryFrame.bytes[i]);
}

int mapInteger(int n, int inMin, int inMax, int outMin, int outMax) {
 return (n - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}

float mapFloat(float n, float inMin, float inMax, float outMin, float outMax) {
 return (n - inMin) * (outMax - outMin) / (inMax - inMin) + outMin;
}

int constrain(int n, int min, int max) {
 if(n < min)
  n = min;
 else if(n > max)
  n = max;

 return n;
}

void ui(Mat &image, bool &updated) {
 static bool buttonLess = false;
 static bool oldButtonLess = false;
 static bool buttonMore = false;
 static bool oldButtonMore = false;
 static bool buttonOk = false;
 static bool oldButtonOk = false;

 if(updated) {
  buttonLess = remoteFrame.switchs & 0b00010000;
  buttonMore = remoteFrame.switchs & 0b00100000;
  buttonOk = remoteFrame.switchs & 0b10000000;
 }

 //

 oldButtonLess = buttonLess;
 oldButtonMore = buttonMore;
 oldButtonOk = buttonOk;
}

void imuThread() {
 int oldStdout = dup(fileno(stdout));
 dup2(fileno(stderr), fileno(stdout));

 RTIMUSettings *settings = new RTIMUSettings("RTIMULib");
 RTIMU *imu = RTIMU::createIMU(settings);
 if(imu == NULL || imu->IMUType() == RTIMU_TYPE_NULL) {
  fprintf(stderr, "No IMU found\n");
  return;
 }

 imu->IMUInit();
 imu->setSlerpPower(0.02);
 imu->setGyroEnable(true);
 imu->setAccelEnable(true);
 imu->setCompassEnable(false);

 dup2(oldStdout, fileno(stdout));

 while(run) {
  usleep(imu->IMUGetPollInterval() * 1000);
  while(imu->IMURead())
   imuData = imu->getIMUData();
 }
}

int main(int argc, char* argv[]) {
 if(argc != 4) {
  width = WIDTH;
  height = HEIGHT;
  fps = FPS;
 } else {
  sscanf(argv[1], "%d", &width);
  sscanf(argv[2], "%d", &height);
  sscanf(argv[3], "%d", &fps);
 }

 int fd = serialOpen(DEVROBOT, DEVDEBIT);
 if(fd == -1) {
  fprintf(stderr, "Error opening serial port\n");
  return 1;
 }

 thread imuThr(imuThread);

 Mat image;
 int size = width * height * 3;

 telemetryFrame.header[0] = '$';
 telemetryFrame.header[1] = 'R';
 telemetryFrame.header[2] = ' ';
 telemetryFrame.header[3] = ' ';

 VideoCapture capture;
 capture.open(0);
 while(run) {
  capture.read(image);

  bool updated = readModem(fd);

  //ui(image, updated);

  double x = -imuData.fusionPose.x();
  double y = -imuData.fusionPose.y();
  int offset = int(y * 300.0);
  int x1 = width / 2 + sin(x - M_PI / 2) * 1000;
  int y1 = height / 2 + cos(x - M_PI / 2) * 1000 + offset;
  int x2 = width / 2 + sin(x + M_PI / 2) * 1000;
  int y2 = height / 2 + cos(x + M_PI / 2) * 1000 + offset;
  line(image, Point(x1, y1), Point(x2, y2), Scalar::all(255), 2, LINE_AA);

  if(updated) {
   for(int i = 0; i < NBCOMMANDS; i++) {
    telemetryFrame.xy[i][0] = remoteFrame.xy[i][0];
    telemetryFrame.xy[i][1] = remoteFrame.xy[i][1];
   }
   telemetryFrame.z = remoteFrame.z;
   telemetryFrame.vx = remoteFrame.vx;
   telemetryFrame.vy = remoteFrame.vy;
   telemetryFrame.vz = remoteFrame.vz;
   telemetryFrame.switchs = remoteFrame.switchs;

   writeModem(fd);
  }

  fwrite(image.data, size, 1, stdout);
 }

 return 0;
}