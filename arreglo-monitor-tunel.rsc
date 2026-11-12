# Corrige la URL del monitor del tunel (villanet-backend-xoc2)
/system script remove [find name=monitor-tunel]
/system script add name=monitor-tunel dont-require-permissions=no policy=ftp,reboot,read,write,policy,test,password,sniff,sensitive,romon source=":local resultado [/ping 10.10.11.1 count=3]\r\
    \n:local estado \"\"\r\
    \n:local detalle \"\"\r\
    \n:if (\$resultado = 0) do={\r\
    \n    :log warning \"VillaNet: tunel caido, reiniciando vpn-oracle\"\r\
    \n    /interface l2tp-client disable vpn-oracle\r\
    \n    :delay 3s\r\
    \n    /interface l2tp-client enable vpn-oracle\r\
    \n    :log warning \"VillaNet: vpn-oracle reiniciado por script de monitoreo\"\r\
    \n    :set estado \"reparado\"\r\
    \n    :set detalle \"0 de 3 pings, tunel reiniciado\"\r\
    \n} else={\r\
    \n    :log info \"VillaNet: tunel OK, \$resultado de 3 pings exitosos\"\r\
    \n    :set estado \"ok\"\r\
    \n    :set detalle (\"\$resultado de 3 pings exitosos\")\r\
    \n}\r\
    \n/tool fetch url=\"https://villanet-backend-xoc2.onrender.com/api/monitor-tunel\" http-method=post http-header-field=\"Content-Type:application/json,x-monitor-token:villanet-monitor-2026-xyz\" http-data=\"{\\\"estado\\\":\\\"\$estado\\\",\\\"detalle\\\":\\\"\$detalle\\\"}\" keep-result=no\r\
    \n"
